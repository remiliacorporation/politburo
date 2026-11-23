import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../rotate-logs.mjs', import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rotate-logs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function rotate(dir, ...args) {
  const run = spawnSync(process.execPath, [script, '--dir', dir, '--max-bytes', '4', ...args], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

// Catches replacing the live file or leaving the rotated logs readable by others.
test('an open append writer keeps writing to the original log after rotation', { timeout: 5000 }, async (t) => {
  const dir = fixture(t);
  const log = join(dir, 'service.log');
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
    import { open } from 'node:fs/promises';
    const fd = await open(process.argv[1], 'a');
    await fd.write('before\\n');
    process.once('message', async () => {
      await fd.write('after\\n');
      await fd.close();
      process.disconnect();
    });
    process.send('ready');
  `, log], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(writer, 'exit');
  t.after(async () => {
    writer.kill();
    await exited;
  });
  const [message] = await once(writer, 'message', { signal: t.signal });
  assert.equal(message, 'ready');
  chmodSync(log, 0o644);
  assert.equal(rotate(dir), 'rotated  service.log  7\n');
  writer.send('append');
  assert.deepEqual(await exited, [0, null]);
  assert.equal(readFileSync(log, 'utf8'), 'after\n');
  assert.equal(readFileSync(`${log}.1`, 'utf8'), 'before\n');
  assert.equal(statSync(log).mode & 0o777, 0o600);
  assert.equal(statSync(`${log}.1`).mode & 0o777, 0o600);
});

// Catches unbounded retention or shifting archives in the wrong order.
test('keeps only the two newest archives after four rotations', (t) => {
  const dir = fixture(t);
  const log = join(dir, 'service.log');
  for (let n = 1; n <= 4; n++) {
    writeFileSync(log, `batch ${n}\n`, { mode: 0o600 });
    rotate(dir, '--keep', '2');
  }
  assert.deepEqual(readdirSync(dir).sort(), ['service.log', 'service.log.1', 'service.log.2']);
  assert.equal(readFileSync(`${log}.1`, 'utf8'), 'batch 4\n');
  assert.equal(readFileSync(`${log}.2`, 'utf8'), 'batch 3\n');
});

// Catches rotating logs at or below the limit or touching unrelated files.
test('leaves small logs and unrelated files alone and prints nothing', (t) => {
  const dir = fixture(t);
  const files = { 'small.log': 'tiny', 'notes.txt': 'not a log', 'state.db': 'also not a log' };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  assert.equal(rotate(dir), '');
  assert.deepEqual(readdirSync(dir).sort(), Object.keys(files).sort());
  for (const [name, content] of Object.entries(files)) {
    assert.equal(readFileSync(join(dir, name), 'utf8'), content);
  }
});
