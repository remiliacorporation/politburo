import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../run-with-env.sh', import.meta.url));

function fixture(t, content, mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), 'run-with-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'service.env');
  writeFileSync(file, content, { mode });
  chmodSync(file, mode);
  return { dir, file };
}

// Catches accepting a world-readable env file or disclosing its value on refusal.
test('refuses a 0644 env file without leaking its contents', (t) => {
  const { file } = fixture(t, 'K={{FIXTURE}}\n', 0o644);
  const run = spawnSync(script, [file, '--', 'true'], { encoding: 'utf8' });
  assert.equal(run.status, 78);
  assert.ok(run.stderr.includes(`${file}: mode must be 0600 or stricter`));
  assert.ok(!(run.stdout + run.stderr).includes('{{FIXTURE}}'));
});

// Catches failing to export a valid assignment or exposing its value under sh -x.
test('exports from a 0600 env file without tracing its value', (t) => {
  const { file } = fixture(t, '# fixture\n\nK="{{FIXTURE}} with spaces"');
  const run = spawnSync('sh', ['-x', script, file, '--', 'sh', '-c', 'printf %s "$K"'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '{{FIXTURE}} with spaces');
  assert.ok(!run.stderr.includes('{{FIXTURE}}'));
});

// Catches sourcing the file or otherwise evaluating shell syntax in a value.
test('passes a command substitution literally without running it', (t) => {
  const { dir, file } = fixture(t, 'K="$(touch marker)"\n');
  const run = spawnSync(script, [file, '--', 'sh', '-c', 'printf %s "$K"'], {
    cwd: dir, encoding: 'utf8',
  });
  assert.equal(run.status, 0);
  assert.equal(existsSync(join(dir, 'marker')), false);
  assert.equal(run.stdout, '$(touch marker)');
});

// Catches leaving a wrapper shell in place instead of handing its PID to the service.
test('the launched PID handles SIGTERM and returns the service exit status', { timeout: 5000 }, async (t) => {
  const { file } = fixture(t, '');
  const child = spawn(script, [file, '--', process.execPath, '-e', `
    process.on('SIGTERM', () => process.exit(0));
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(1));
    console.log(process.pid);
  `]);
  const closed = once(child, 'close');
  t.after(async () => {
    child.stdin.end();
    child.kill('SIGKILL');
    await closed;
  });
  const lines = createInterface({ input: child.stdout });
  const { value: pid } = await lines[Symbol.asyncIterator]().next();
  assert.equal(Number(pid), child.pid);
  assert.equal(child.kill('SIGTERM'), true);
  assert.deepEqual(await closed, [0, null]);
});
