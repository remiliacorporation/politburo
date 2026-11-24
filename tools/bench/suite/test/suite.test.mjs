import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runName } from '../run.mjs';
import { exportPatch, verifyModes } from '../export.mjs';
import { validRating } from '../../record.mjs';
import { isBenchRun } from '../../../../packages/runtime/src/bench/record.ts';

const here = path => fileURLToPath(new URL(path, import.meta.url));
const repo = here('../../../../');
const suite = 'tools/bench/suite';
const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const json = path => JSON.parse(readFileSync(path, 'utf8'));

const tasks = json(join(repo, suite, 'tasks.json'));
const objectExists = ref => spawnSync('git', ['cat-file', '-e', ref], { cwd: repo, env, stdio: 'ignore' }).status === 0;

test('the suite has three rated tasks and clean briefs', () => {
  assert.equal(tasks.length, 3);
  assert.equal(new Set(tasks.map(t => t.id)).size, 3);
  for (const t of tasks) {
    assert.match(t.id, /^[a-z0-9][a-z0-9-]*$/);
    assert.ok(t.title.trim());
    for (const ref of [t.base, t.goldenRef]) assert.match(ref, /^[a-f0-9]{40}$/);
    assert.ok(t.goldenFiles.length);
    assert.ok(t.goldenCommand.length && t.goldenCommand.every(x => typeof x === 'string'));
    assert.ok(Array.isArray(t.setup) && t.setup.every(a => Array.isArray(a) && a.length && a.every(x => typeof x === 'string')));
    assert.ok(Number.isSafeInteger(t.timeCapSeconds) && t.timeCapSeconds > 0);
    assert.ok(validRating(t.rating));
    assert.equal(t.rating.ratedBy, '218-BEE7');
    assert.equal(t.briefFile, `${suite}/briefs/${t.id}.md`);
    const brief = readFileSync(join(repo, t.briefFile), 'utf8');
    assert.match(brief.trimEnd(), /Do not commit, do not read any git history beyond the working tree\.$/);
    assert.doesNotMatch(brief, /\b(?:describe|test)\s*\(/);
    for (const file of t.goldenFiles) {
      assert.ok(!brief.includes(basename(file)), `${t.id} brief names a golden file`);
    }
  }
});

test('every golden file was added by its recorded merge', t => {
  if (git(repo, 'rev-parse', '--is-shallow-repository') === 'true'
    && tasks.some(task => !objectExists(task.base) || !objectExists(task.goldenRef))) {
    return t.skip('historical commits not available in shallow checkout');
  }
  for (const task of tasks) {
    for (const ref of [task.base, task.goldenRef]) assert.equal(git(repo, 'cat-file', '-t', ref), 'commit');
    assert.equal(git(repo, 'rev-parse', `${task.goldenRef}^1`), task.base);
    for (const file of task.goldenFiles) {
      assert.equal(git(repo, 'cat-file', '-t', `${task.goldenRef}:${file}`), 'blob');
      assert.equal(spawnSync('git', ['cat-file', '-e', `${task.base}:${file}`], { cwd: repo, env, stdio: 'ignore' }).status, 128);
    }
  }
});

test('run names normalize slugs and label omitted settings', () => {
  const name = runName('serve-swarm-flag', 'Provider/Model:V2.0', 'HIGH_EFFORT', 5, 17);
  assert.match(name, /^[a-z0-9._-]+$/);
  assert.equal(name, 'bench.serve-swarm-flag.provider-model-v2.0.high_effort.r5.17');
  assert.equal(runName('task', undefined, undefined, 1, 18), 'bench.task.default.default.r1.18');
});

const rating = { score: 4, size: 'S', reason: 'Fixture rating.', ratedBy: '218-BEE7', ratedAt: '2025-01-01T00:00:00.000Z' };
const gitKeys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
const absentGit = Object.fromEntries(gitKeys.map(key => [key, 'absent']));
// Record only presence and comparisons, never an environment value.
const observe = `
const fs = require('node:fs'), path = require('node:path'), e = process.env;
const obs = (...parts) => path.join(e.OBS, ...parts);
const note = (file, value) => fs.writeFileSync(obs(file), JSON.stringify(value));
const present = key => Object.hasOwn(e, key) ? 'present' : 'absent';
const exportGit = () => Object.fromEntries(${JSON.stringify(gitKeys)}.map(key => [key, present(key)]));
const home = () => ({ isolated: e.HOME !== obs('runner-home') && path.dirname(e.HOME) === obs('work')
  && (fs.statSync(e.HOME).mode & 0o777) === 0o700,
  xdg: ['CONFIG', 'CACHE', 'DATA'].every(key => path.dirname(e['XDG_' + key + '_HOME']) === e.HOME) });
`;
function treeDigest(root, { lstatSync, readFileSync, readdirSync, readlinkSync }, join, createHash) {
  const hash = createHash('sha256');
  function walk(rel) {
    const file = join(root, rel), stat = lstatSync(file);
    const type = stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'link' : stat.isFile() ? 'file' : 'special';
    const content = type === 'link' ? readlinkSync(file)
      : type === 'file' ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
    hash.update(JSON.stringify([rel, type, stat.mode, content]));
    if (type === 'dir') for (const child of readdirSync(file).sort()) walk(join(rel, child));
  }
  walk('.');
  return hash.digest('hex');
}

const digest = path => treeDigest(path, { lstatSync, readFileSync, readdirSync, readlinkSync }, join, createHash);

function fixture(t, mode, timeout = 10_000) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bench-suite-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'repo');
  mkdirSync(cwd);
  git(cwd, 'init', '--template=');
  const commit = () => {
    git(cwd, 'add', '--all');
    git(cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--no-gpg-sign', '-m', 'Fixture');
    return git(cwd, 'rev-parse', 'HEAD');
  };
  writeFileSync(join(cwd, 'answer'), 'base');
  writeFileSync(join(cwd, 'obsolete'), 'obsolete\n');
  writeFileSync(join(cwd, 'setup-location'), 'not set up\n');
  writeFileSync(join(cwd, '.gitignore'), 'ignored\nignored-link\nignored-dir/\n');
  mkdirSync(join(cwd, 'swap'));
  writeFileSync(join(cwd, 'swap/file'), 'tracked\n');
  writeFileSync(join(cwd, '.gitattributes'), 'added export-ignore\n');
  if (mode === 'encoding-base' || mode === 'encoding-archive') {
    const hide = mode === 'encoding-archive' ? '.gitattributes export-ignore\n' : '';
    writeFileSync(join(cwd, '.gitattributes'), hide + '*.txt working-tree-encoding=UTF-16LE\n');
    writeFileSync(join(cwd, 'encoded.txt'), Buffer.from('abcd', 'utf16le'));
  }
  if (mode === 'encoding-nested') {
    writeFileSync(join(cwd, 'swap/.gitattributes'), '"space *.txt" working-tree-encoding=UTF-16LE\r\n');
    writeFileSync(join(cwd, 'swap/space encoded.txt'), Buffer.from('abcd', 'utf16le'));
  }
  if (mode === 'text-attrs') writeFileSync(join(cwd, '.gitattributes'), '* text eol=lf\n*.txt filter=example\n# *.txt working-tree-encoding=UTF-16LE\nworking-tree-encoding text\n');
  const base = commit();
  writeFileSync(join(cwd, 'answer'), 'fixed');
  mkdirSync(join(cwd, 'checks'));
  writeFileSync(join(cwd, 'checks/golden.cjs'), `${observe}
note('golden', { cwd: process.cwd(), secret: present('BENCH_FIXTURE_SECRET_TOKEN'), exportGit: exportGit(), ...home(),
  setupHere: fs.readFileSync('setup-location', 'utf8') === process.cwd(),
  goldenInstalledBeforeSetup: fs.existsSync('setup-saw-golden') });
console.log('check stdout');
console.error('check stderr');
if (e.MODE === 'straggler') {
  const stop = Date.now() + 2000;
  while (!fs.existsSync(obs('straggler-done')) && Date.now() < stop)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  if (!fs.existsSync(obs('straggler-done')) || fs.existsSync('obsolete')) process.exit(1);
}
process.exitCode = fs.readFileSync('answer', 'utf8') === 'fixed' &&
  fs.readFileSync('ignored', 'utf8') === 'fixed' && fs.existsSync('added') &&
  !fs.existsSync('pipe') && !fs.existsSync('ignored-dir') && !fs.existsSync('ignored-link') ? 0 : 1;
`);
  const goldenRef = commit();
  const setup = `${observe}
fs.appendFileSync(obs('setup'), present('BENCH_FIXTURE_SECRET_TOKEN') + '\\n');
fs.appendFileSync(obs('setup-git'), JSON.stringify(exportGit()) + '\\n');
if (e.MODE === 'encoding-setup') fs.appendFileSync('.gitattributes', '*.txt working-tree-encoding=UTF-16LE\\n');
const answer = fs.readFileSync('answer');
fs.writeFileSync('setup-location', process.cwd());
if (fs.existsSync('checks/golden.cjs') && fs.readFileSync('checks/golden.cjs', 'utf8').includes('process.exitCode'))
  fs.writeFileSync('setup-saw-golden', 'yes');
fs.writeFileSync('ready', answer);
fs.writeFileSync('ignored', answer);
`;
  const task = { id: 'fixture', title: 'Fixture', base, goldenRef, goldenFiles: ['checks/golden.cjs'],
    goldenCommand: ['node', 'checks/golden.cjs'], setup: [['node', '-e', setup]],
    timeCapSeconds: 1, briefFile: `${suite}/briefs/fixture.md`, rating };
  mkdirSync(join(cwd, suite, 'briefs'), { recursive: true });
  writeFileSync(join(cwd, suite, 'tasks.json'), JSON.stringify([task]));
  writeFileSync(join(cwd, task.briefFile), 'Fixture brief.\n');
  const launcher = join(dir, 'fake-sprite-start'), sprites = join(dir, 'sprites');
  const work = join(dir, mode === 'default-work' ? 'bench-suite' : 'work');
  const results = mode === 'results-dir' ? join(dir, 'results') : work;
  const defaults = ['results-dir', 'default-out', 'default-work'].includes(mode);
  const out = join(results, defaults ? 'results.jsonl' : mode === 'out-root-file' ? 'bench-records.jsonl' : 'records.jsonl');
  if (mode !== 'default-work') mkdirSync(work, { mode: 0o700 });
  if (mode === 'out-append') writeFileSync(out, '{"previous":true}\n');
  if (mode === 'out-run-tree') mkdirSync(join(work, 'bench-previous'));
  if (mode === 'out-parent') symlinkSync('../outside', join(work, 'linked-parent'));
  if (mode === 'out-parent-inside') {
    mkdirSync(join(work, 'inside'));
    symlinkSync('inside', join(work, 'linked-parent'));
  }
  mkdirSync(join(dir, 'runner-home'));
  mkdirSync(join(dir, 'outside'));
  writeFileSync(join(dir, 'outside/golden.cjs'), 'untouched');
  const other = join(dir, 'outside/other');
  if (['out-symlink', 'out-hardlink'].includes(mode)) {
    writeFileSync(other, 'untouched');
    if (mode === 'out-symlink') symlinkSync(other, out);
    if (mode === 'out-hardlink') linkSync(other, out);
  }
  if (mode === 'out-directory') mkdirSync(out);
  if (mode === 'out-fifo') execFileSync('mkfifo', [out], { env });
  writeFileSync(join(dir, 'monitor'), '#!/bin/sh\ntouch "$OBS/outside/monitor-ran"\n', { mode: 0o700 });
  const hostile = {};
  let decoy, decoyBefore;
  if (mode === 'hostile-git') {
    decoy = join(dir, 'decoy');
    mkdirSync(decoy);
    git(decoy, 'init', '--template=');
    writeFileSync(join(decoy, 'decoy'), 'untouched');
    git(decoy, 'add', '--all');
    git(decoy, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Decoy');
    const admin = join(decoy, '.git'), monitor = join(dir, 'monitor');
    git(decoy, 'config', 'core.fsmonitor', monitor);
    writeFileSync(join(dir, 'outside/post-index-change'), '#!/bin/sh\ntouch "$OBS/outside/hook-ran"\n', { mode: 0o700 });
    const global = join(dir, 'global');
    git(dir, 'config', '--file', global, 'core.fsmonitor', monitor);
    Object.assign(hostile, { GIT_DIR: admin, GIT_WORK_TREE: decoy, GIT_INDEX_FILE: join(admin, 'index'),
      GIT_OBJECT_DIRECTORY: join(admin, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(admin, 'objects'),
      GIT_CONFIG_GLOBAL: global, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: monitor,
      GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: join(dir, 'outside') });
    decoyBefore = digest(decoy);
    mkdirSync(join(dir, 'bin'));
    for (const tool of ['git', 'tar']) {
      const forbidden = tool === 'tar' ? gitKeys : ['GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT',
        'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1'];
      writeFileSync(join(dir, 'bin', tool), `#!/bin/sh
[ -z "${forbidden.map(key => '${' + key + '+x}').join('')}" ] || exit 99
PATH="\${PATH#*:}" exec ${tool} "$@"
`, { mode: 0o700 });
    }
  }
  const outsideBefore = digest(join(dir, 'outside'));
  // Observe the real collector at process startup, without replacing it.
  const preload = join(dir, 'collector-probe.cjs');
  writeFileSync(preload, `${observe}
if (process.argv[1]?.endsWith('/sprite-usage.mjs')) {
  const index = process.argv.indexOf('--worktree');
  note('collector', { secret: present('BENCH_FIXTURE_SECRET_TOKEN'), exportGit: exportGit(),
    worktree: index < 0 ? null : process.argv[index + 1], afterGolden: fs.existsSync(obs('golden')) });
}
`);
  writeFileSync(join(dir, 'launcher-probe.cjs'), `${observe}
note('launcher', { cwd: process.cwd(), secret: present('BENCH_FIXTURE_SECRET_TOKEN'), exportGit: exportGit(), ...home(),
  allowed: present('FIXTURE_ACCESS'), git: present('GIT_FIXTURE_SENTINEL'), bench: present('BENCH_REPO'),
  launcherConfig: present('BENCH_SPRITE_START'), grace: present('BENCH_RC_GRACE_SECONDS'),
  invalid: present('FIXTURE-BAD'), unset: present('UNSET_FIXTURE'),
  path: e.PATH?.split(path.delimiter)[0] === obs('bin'),
  gradingAlreadyExists: fs.readdirSync(obs(e.MODE === 'default-work' ? 'bench-suite' : 'work')).some(name => name.startsWith('bench-grade-')) });
`);
  writeFileSync(join(dir, 'tree-probe.cjs'), `${observe}
${treeDigest.toString()}
note('sprite-digest', treeDigest(process.cwd(), fs, path.join, require('node:crypto').createHash));
`);
  const pinned = mode === 'pass';
  writeFileSync(launcher, `#!/bin/sh
set -eu
case "$MODE" in encoding-base|encoding-nested|encoding-archive) [ ! -e ready ] || exit 9;; *) [ -f ready ] || exit 9;; esac
[ -s "$2" ] || exit 9
[ ! -e checks/golden.cjs ] && [ "$(git rev-parse --show-toplevel)" = "$PWD" ] || exit 9
node "$OBS/launcher-probe.cjs"
[ "$3" = "$EXPECTED_CAP" ] && [ "\${PI_MODEL-unset}" = "$EXPECTED_MODEL" ] && [ "\${PI_THINKING-unset}" = "$EXPECTED_THINKING" ] || exit 9
printf 'sprite stdout\n'
printf 'sprite stderr\n' >&2
[ "$MODE" != fail-start ] || exit 9
cp "$FIXTURE_LOG" "$SPRITES/$1.jsonl"
if [ "$MODE" = pass ] || [ "$MODE" = straggler ] || [ "$MODE" = objects ] ||
   [ "$MODE" = ignored-fifo ] || [ "$MODE" = fifo ] || [ "$MODE" = nested ]; then
  printf fixed > answer; printf 'one\ntwo\n' > added; mkdir checks; printf 'mine\n' > checks/golden.cjs
  ln checks/golden.cjs "$OBS/sprite-original"
fi
if [ "$MODE" = unstaged ] || [ "$MODE" = one-line ]; then printf fixed > answer; fi
if [ "$MODE" = unstaged ]; then
  printf 'new\n' > added; printf 'not work\n' > ignored; ln -s "$OBS/missing-target" ignored-link
  rm obsolete
fi
if [ "$MODE" = objects ]; then
  mv .git/objects moved-objects; ln -s "$PWD/moved-objects" .git/objects
  printf '/moved-objects/\\n' >> .gitignore
fi
if [ "$MODE" = ignored-fifo ]; then mkdir ignored-dir; mkfifo ignored-dir/pipe; fi
if [ "$MODE" = fifo ]; then mkfifo pipe; fi
if [ "$MODE" = bad-ignore ] || [ "$MODE" = encoding-setup ]; then mkfifo .gitignore.tmp; mv -f .gitignore.tmp .gitignore; fi
if [ "$MODE" = golden-collision ]; then printf collision > checks; fi
if [ "$MODE" = encoding-added ]; then printf '*.txt working-tree-encoding=UTF-16LE\\n' > swap/.gitattributes; fi
if [ "$MODE" = encoding-edited ]; then printf '*.txt working-tree-encoding=UTF-16LE\\n' >> .gitattributes; fi
if [ "$MODE" = binary ]; then printf '\\000\\377\\002' > binary; chmod +x binary; fi
if [ "$MODE" = nested ]; then
  git init -q --template= nested-dir
  git init -q --template= --separate-git-dir="$OBS/outside/admin" nested-file
  git -C nested-dir config core.fsmonitor "$OBS/monitor"
  git -C nested-file config core.hooksPath "$OBS/outside"
  printf 'kept\\n' > nested-dir/content; printf 'kept\\n' > nested-file/content
fi
if [ "$MODE" = straggler ]; then rm obsolete; fi
if [ "$MODE" = symlink ]; then
  rm -r swap; ln -s "$OBS/outside" swap
  printf '/swap\\n' >> .gitignore
fi
if [ "$MODE" = unstaged ] || [ "$MODE" = objects ]; then node "$OBS/tree-probe.cjs"; fi
if [ "$MODE" != no-rc ]; then (
  printf '${pinned ? '3' : '0'}\n' > "$SPRITES/$1.pending"; mv "$SPRITES/$1.pending" "$SPRITES/$1.rc"
  if [ "$MODE" = straggler ]; then
    for i in $(seq 200); do [ ! -e "$OBS/golden" ] || break; sleep 0.01; done
    printf late > answer; mv checks saved-checks; ln -s "$OBS/outside" checks
    touch "$OBS/straggler-done"
  fi
) & fi
`, { mode: 0o700 });
  const passEnv = 'OBS,FIXTURE_LOG,SPRITES,MODE,EXPECTED_MODEL,EXPECTED_THINKING,EXPECTED_CAP,NODE_OPTIONS,'
    + 'HOME,XDG_CONFIG_HOME,XDG_CACHE_HOME,XDG_DATA_HOME,PI_MODEL,PI_THINKING,GIT_FIXTURE_SENTINEL,BENCH_REPO,BENCH_SPRITE_START,BENCH_RC_GRACE_SECONDS,FIXTURE-BAD,UNSET_FIXTURE,'
    + gitKeys.join(',');
  const paths = {
    'out-outside': join(dir, 'outside/records.jsonl'), 'out-parent': join(work, 'linked-parent/records.jsonl'),
    'out-dotdot': `${work}/../work/records.jsonl`, 'out-dot': `${out}/.`, 'out-slash': `${out}/`,
    'out-run-tree': join(work, 'bench-previous/records.jsonl'),
    'out-parent-inside': join(work, 'linked-parent/records.jsonl'),
  };
  const cli = mode === 'out-append' ? ['--input-type=module', '-e', `
    import { readdirSync, statSync, writeFileSync } from 'node:fs';
    import { runSuite } from ${JSON.stringify(new URL('../run.mjs', import.meta.url).href)};
    process.exitCode = await runSuite({ args: process.argv.slice(1), beforeLaunch() {
      const target = statSync(${JSON.stringify(out)});
      const open = readdirSync('/proc/self/fd').filter(fd => {
        const entry = statSync('/proc/self/fd/' + fd, { throwIfNoEntry: false });
        return entry?.dev === target.dev && entry.ino === target.ino;
      });
      writeFileSync(${JSON.stringify(join(dir, 'open-count'))}, String(open.length));
    } });`, '--'] : [here('../run.mjs')];
  const result = spawnSync(process.execPath, [...cli, '--task', task.id,
    ...(mode === 'default-work' ? [] : ['--work', work]),
    ...(mode === 'results-dir' ? ['--results-dir', results] : []),
    ...(defaults ? [] : ['--out', paths[mode] ?? out]), '--sprites', sprites,
    ...(pinned ? ['--model', 'Requested/Model', '--thinking', 'high', '--rep', '2', '--max-seconds', '3'] : [])],
  { cwd: dir, encoding: 'utf8', timeout, env: { PATH: [join(dir, 'bin'), process.env.PATH].join(':'), BENCH_REPO: cwd, BENCH_SPRITE_START: launcher,
    BENCH_PASS_ENV: passEnv + (pinned ? ',FIXTURE_ACCESS' : ''), HOME: join(dir, 'runner-home'),
    XDG_CONFIG_HOME: join(dir, 'runner-home'), XDG_CACHE_HOME: join(dir, 'runner-home'), XDG_DATA_HOME: join(dir, 'runner-home'),
    OBS: dir, NODE_OPTIONS: `--require=${preload}`, TMPDIR: dir,
    BENCH_FIXTURE_SECRET_TOKEN: 'placeholder', GIT_FIXTURE_SENTINEL: 'placeholder', GIT_INDEX_FILE: 'placeholder',
    FIXTURE_ACCESS: 'placeholder', 'FIXTURE-BAD': 'placeholder',
    BENCH_RC_GRACE_SECONDS: '0', FIXTURE_LOG: here('../../test/fixtures/single.jsonl'), SPRITES: sprites, MODE: mode,
    PI_MODEL: 'ignored', PI_THINKING: 'ignored', EXPECTED_MODEL: pinned ? 'Requested/Model' : 'unset',
    EXPECTED_THINKING: pinned ? 'high' : 'unset', EXPECTED_CAP: pinned ? '3' : '1', ...hostile } });
  if (result.error) throw result.error;
  return { result, out: mode === 'out-parent-inside' ? paths[mode] : out, work, results, sprites, base, goldenRef,
    dir, outsideBefore, decoy, decoyBefore, launcher: existsSync(join(dir, 'launcher')) ? json(join(dir, 'launcher')) : null };
}

function assertGitAbsent(dir, launcher) {
  for (const child of [launcher, json(join(dir, 'golden')), json(join(dir, 'collector'))]) {
    assert.deepEqual(child.exportGit, absentGit);
  }
  assert.deepEqual(readFileSync(join(dir, 'setup-git'), 'utf8').trim().split('\n').map(JSON.parse), [absentGit, absentGit]);
}

test('hostile caller Git settings do not reach children or affect the decoy', t => {
  const { result, out, dir, launcher, decoy, decoyBefore, outsideBefore } = fixture(t, 'hostile-git');
  assert.equal(result.status, 0, result.stderr);
  assertGitAbsent(dir, launcher);
  assert.deepEqual(json(out).changes, { files: 0, linesAdded: 0, linesRemoved: 0 });
  assert.equal(digest(decoy), decoyBefore);
  assert.equal(digest(join(dir, 'outside')), outsideBefore);
});

test('standalone collector ignores hostile GIT_DIR and gives Git only allowlisted variables', t => {
  const { result, dir, sprites } = fixture(t, 'one-line');
  assert.equal(result.status, 0, result.stderr);
  const { worktree } = json(join(dir, 'collector'));
  const decoy = join(dir, 'decoy'), bin = join(dir, 'bin');
  mkdirSync(decoy);
  mkdirSync(bin);
  git(decoy, 'init', '--template=');
  writeFileSync(join(bin, 'git'), `#!/bin/sh
if [ "\${FIXTURE_UNLISTED+x}" ] || [ "\${GIT_DIR+x}" ]; then exit 99; fi
PATH="\${PATH#*:}" exec git "$@"
`, { mode: 0o700 });
  const name = readdirSync(sprites).find(file => file.endsWith('.rc')).slice(0, -3);
  const collected = spawnSync(process.execPath, [here('../../sprite-usage.mjs'), name, '--dir', sprites,
    '--worktree', worktree, '--base', 'HEAD'], { encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, GIT_DIR: join(decoy, '.git'), FIXTURE_UNLISTED: 'placeholder' } });
  assert.equal(collected.status, 0, collected.stderr);
  assert.deepEqual(JSON.parse(collected.stdout).changes, { files: 1, linesAdded: 1, linesRemoved: 1 });
});

for (const mode of ['encoding-base', 'encoding-nested', 'encoding-archive', 'encoding-setup', 'encoding-added', 'encoding-edited']) {
  test(`blocks unsupported encoding before grading (${mode})`, t => {
    const { result, out, dir } = fixture(t, mode);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^run  [\w.-]+  not_run  refused_encoding\n$/);
    const row = json(out);
    assert.deepEqual(row.outcome, { state: 'blocked', reason: 'refused_encoding' });
    assert.ok(isBenchRun(row), 'ingest accepts the collector record');
    assert.deepEqual(row.check, { result: 'not_run', command: 'node' });
    assert.equal(row.changes, null);
    assert.ok(!existsSync(join(dir, 'golden')));
    if (['encoding-base', 'encoding-nested', 'encoding-archive'].includes(mode)) assert.ok(!existsSync(join(dir, 'setup')));
    else assert.equal(readFileSync(join(dir, 'setup'), 'utf8'), 'absent\n', 'only pre-launch setup ran');
  });
}

test('text, eol and filter attributes do not refuse export', t => {
  const { result, out } = fixture(t, 'text-attrs');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(out).check.result, 'fail', 'golden check ran');
  assert.deepEqual(json(out).changes, { files: 0, linesAdded: 0, linesRemoved: 0 });
});

for (const verdict of ['pass', 'fail']) test(`runner records golden ${verdict} and keeps subprocess output private`, t => {
  const { result, out, dir, launcher } = fixture(t, verdict);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const golden = json(join(dir, 'golden'));
  assert.deepEqual({ launcher: launcher.secret, golden: golden.secret, collector: json(join(dir, 'collector')).secret,
    setup: readFileSync(join(dir, 'setup'), 'utf8').trim().split('\n') },
  { launcher: 'absent', golden: 'absent', collector: 'absent', setup: ['absent', 'absent'] });
  assertGitAbsent(dir, launcher);
  for (const child of [launcher, golden]) assert.ok(child.isolated && child.xdg, 'private HOME and XDG directories');
  assert.equal(launcher.path, true);
  assert.equal(launcher.allowed, verdict === 'pass' ? 'present' : 'absent');
  for (const key of ['invalid', 'unset', 'git', 'bench', 'launcherConfig', 'grace']) assert.equal(launcher[key], 'absent', key);
  const slug = verdict === 'pass' ? 'requested-model.high.r2' : 'default.default.r1';
  const name = result.stdout.match(/^run  (bench\.[a-z0-9._-]+)  (pass|fail)\n$/);
  assert.ok(name, 'one summary line');
  assert.equal(name[2], verdict);
  assert.ok(name[1].startsWith(`bench.fixture.${slug}.`));
  const row = json(out);
  assert.equal(row.schema, 'bench-run@1');
  assert.equal(row.runId, name[1]);
  assert.equal(row.taskId, 'fixture');
  assert.deepEqual(row.check, { result: verdict, command: 'node' });
  assert.deepEqual(row.complexity.rating, rating);
  assert.deepEqual(row.model, { provider: 'p1', name: 'm1' });
  assert.equal(row.thinking, 'low');
  // A file the sprite created counts as a change; the restored golden file does not.
  // The sprite's own file at the golden path counts (1 line), the restored golden file does not.
  assert.deepEqual(row.changes, verdict === 'pass' ? { files: 3, linesAdded: 4, linesRemoved: 1 } : { files: 0, linesAdded: 0, linesRemoved: 0 });
  // The verdict does not follow the sprite's exit code.
  assert.deepEqual(row.outcome, verdict === 'pass' ? { state: 'failed', reason: 'exit 3' } : { state: 'done', reason: null });
});

test('grading counts unstaged and untracked work without changing any sprite bytes', t => {
  const { result, out, dir, launcher } = fixture(t, 'unstaged');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(digest(launcher.cwd), json(join(dir, 'sprite-digest')), 'sprite tree and .git must be unchanged');
  assert.deepEqual(json(out).changes, { files: 3, linesAdded: 2, linesRemoved: 2 });
});

for (const mode of ['noop', 'one-line']) test(`directory-dependent setup does not count as work (${mode})`, t => {
  const { result, out, dir, launcher } = fixture(t, mode);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(json(out).changes, mode === 'noop'
    ? { files: 0, linesAdded: 0, linesRemoved: 0 } : { files: 1, linesAdded: 1, linesRemoved: 1 });
  const golden = json(join(dir, 'golden'));
  assert.equal(golden.setupHere, true);
  assert.equal(golden.goldenInstalledBeforeSetup, true);
  const stats = json(join(dir, 'collector')).worktree;
  assert.equal(readFileSync(join(stats, 'setup-location'), 'utf8'), launcher.cwd);
  assert.ok(!existsSync(join(stats, 'setup-saw-golden')));
  assert.equal(git(golden.cwd, 'rev-parse', 'HEAD'), git(launcher.cwd, 'rev-parse', 'HEAD'));
});

test('grading a snapshot ignores a late edit and symlink swap in the sprite tree', t => {
  const { result, out, dir, work, launcher } = fixture(t, 'straggler');
  assert.ok(existsSync(join(dir, 'straggler-done')), 'straggler ran after exit');
  assert.equal(readFileSync(join(dir, 'outside/golden.cjs'), 'utf8'), 'untouched');
  const golden = json(join(dir, 'golden'));
  assert.notEqual(golden.cwd, launcher.cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(dirname(golden.cwd), work);
  assert.equal(lstatSync(golden.cwd).mode & 0o777, 0o700);
  assert.equal(launcher.gradingAlreadyExists, false);
  assert.equal(readFileSync(join(launcher.cwd, 'answer'), 'utf8'), 'late');
  assert.equal(readlinkSync(join(launcher.cwd, 'checks')), join(dir, 'outside'));
  const original = join(launcher.cwd, 'saved-checks/golden.cjs');
  assert.equal(readFileSync(original, 'utf8'), 'mine\n');
  assert.equal(lstatSync(original).ino, lstatSync(join(dir, 'sprite-original')).ino, 'runner never replaced the sprite file');
  const row = json(out);
  assert.equal(row.check.result, 'pass');
  assert.deepEqual(row.changes, { files: 4, linesAdded: 4, linesRemoved: 2 });
});

test('absolute .git/objects symlink leaves the sprite and outside trees unchanged', t => {
  const { result, out, dir, launcher, outsideBefore } = fixture(t, 'objects');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(out).check.result, 'pass');
  assert.equal(readlinkSync(join(launcher.cwd, '.git/objects')), join(launcher.cwd, 'moved-objects'));
  assert.equal(digest(launcher.cwd), json(join(dir, 'sprite-digest')));
  assert.equal(digest(join(dir, 'outside')), outsideBefore);
});

for (const mode of ['ignored-fifo', 'fifo']) test(`grades with a ${mode} present`, { timeout: 4000 }, t => {
  const { result, out, launcher, dir } = fixture(t, mode, 3000);
  assert.equal(result.status, 0, result.stderr);
  const note = mode === 'fifo' ? '  skipped_special=1' : '';
  assert.match(result.stdout, new RegExp(`^run  [\\w.-]+  pass${note}\\n$`));
  assert.equal(json(out).check.result, 'pass');
  const pipe = mode === 'fifo' ? 'pipe' : 'ignored-dir/pipe';
  assert.ok(lstatSync(join(launcher.cwd, pipe)).isFIFO());
  assert.ok(!existsSync(join(json(join(dir, 'collector')).worktree, pipe)));
});

function inodes(dir) {
  const result = new Set();
  for (const name of readdirSync(dir)) {
    const path = join(dir, name), stat = lstatSync(path);
    if (stat.isDirectory()) for (const inode of inodes(path)) result.add(inode);
    if (stat.isFile()) result.add(`${stat.dev}:${stat.ino}`);
  }
  return result;
}

test('grades and collects in separate, independent clones', t => {
  const { result, dir, work, launcher } = fixture(t, 'pass');
  assert.equal(result.status, 0, result.stderr);
  const grade = json(join(dir, 'golden')).cwd;
  const { worktree: stats, afterGolden } = json(join(dir, 'collector'));
  assert.equal(afterGolden, true);
  assert.equal(new Set([stats, grade, launcher.cwd]).size, 3);
  const spriteInodes = inodes(launcher.cwd);
  for (const clone of [stats, grade]) {
    assert.equal(dirname(clone), work);
    assert.equal(lstatSync(clone).mode & 0o777, 0o700);
    assert.ok(lstatSync(join(clone, '.git/objects')).isDirectory());
    assert.equal(lstatSync(join(clone, '.git/objects/info/alternates'), { throwIfNoEntry: false }), undefined);
    assert.ok([...inodes(clone)].every(inode => !spriteInodes.has(inode)), 'no sprite hardlinks');
  }
  assert.equal(readFileSync(join(stats, 'checks/golden.cjs'), 'utf8'), 'mine\n');
  assert.equal(readFileSync(join(launcher.cwd, 'checks/golden.cjs'), 'utf8'), 'mine\n');
  assert.match(readFileSync(join(grade, 'checks/golden.cjs'), 'utf8'), /process\.exitCode/);
});

test('skips nested .git directories and gitfiles without executing their config', t => {
  const { result, out, dir } = fixture(t, 'nested');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(out).check.result, 'pass');
  assert.ok(!existsSync(join(dir, 'outside/monitor-ran')));
  for (const tree of [json(join(dir, 'collector')).worktree, json(join(dir, 'golden')).cwd]) {
    for (const nested of ['nested-dir', 'nested-file']) {
      assert.equal(readFileSync(join(tree, nested, 'content'), 'utf8'), 'kept\n');
      assert.ok(!existsSync(join(tree, nested, '.git')));
    }
  }
});

test('binary patch preserves executable file contents in both clones', t => {
  const { result, out, dir } = fixture(t, 'binary');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(json(out).changes, { files: 1, linesAdded: 0, linesRemoved: 0 });
  for (const cwd of [json(join(dir, 'collector')).worktree, json(join(dir, 'golden')).cwd]) {
    const file = join(cwd, 'binary');
    assert.deepEqual(readFileSync(file), Buffer.from([0, 255, 2]));
    assert.equal(lstatSync(file).mode & 0o100, 0o100);
  }
});

test('a special file in place of ignore metadata refuses export without running grading setup', { timeout: 4000 }, t => {
  const { result, out, dir } = fixture(t, 'bad-ignore', 3000);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^run  [\w.-]+  not_run  refused_export\n$/);
  assert.deepEqual(json(out).outcome, { state: 'blocked', reason: 'refused_export' });
  assert.equal(json(out).changes, null);
  assert.equal(readFileSync(join(dir, 'setup'), 'utf8'), 'absent\n');
});

for (const swap of ['nested repo', 'symlink', 'symlink parent', 'oversized file']) {
  test(`export refuses a replacement (${swap}) swapped in after classification`, t => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bench-race-test-')));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const sprite = join(dir, 'sprite'), trusted = join(dir, 'trusted.git'), scratch = join(dir, 'export');
    mkdirSync(sprite);
    mkdirSync(scratch);
    mkdirSync(join(sprite, 'sub'));
    const leaf = 'sub/answer', file = join(sprite, leaf);
    writeFileSync(file, 'base\n');
    git(sprite, 'init', '--template=');
    git(sprite, 'add', '--', leaf);
    git(sprite, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Fixture');
    const base = git(sprite, 'rev-parse', 'HEAD');
    git(dir, 'clone', '--bare', '--no-hardlinks', sprite, trusted);
    const monitor = join(dir, 'monitor'), marker = join(dir, 'monitor-ran');
    writeFileSync(monitor, '#!/bin/sh\ntouch "$(dirname "$0")/monitor-ran"\n', { mode: 0o700 });
    let liveWorktree = false, injected = false;
    const callGit = (cwd, args, options, gitDir, workTree) => {
      liveWorktree ||= workTree === sprite || cwd === sprite;
      return execFileSync('git', args, { cwd, env: { ...env,
        ...(gitDir && { GIT_DIR: gitDir, GIT_INDEX_FILE: join(scratch, 'index'), GIT_OBJECT_DIRECTORY: join(gitDir, 'objects') }),
        ...(workTree && { GIT_WORK_TREE: workTree }) }, stdio: ['pipe', 'pipe', 'ignore'], ...options });
    };
    assert.throws(() => exportPatch(scratch, sprite, trusted, base, callGit, { afterWalk() {
      injected = true;
      if (swap === 'symlink parent') {
        renameSync(join(sprite, 'sub'), join(dir, 'sub'));
        symlinkSync(join(dir, 'sub'), join(sprite, 'sub'));
      } else {
        rmSync(file);
        if (swap === 'nested repo') {
          git(dir, 'clone', '--no-hardlinks', trusted, file);
          git(file, 'config', 'core.fsmonitor', monitor);
        } else if (swap === 'symlink') symlinkSync('../.git/HEAD', file);
        else {
          writeFileSync(file, '');
          truncateSync(file, 20 * 1024 * 1024 + 1);
        }
      }
    } }), swap.startsWith('symlink') ? /refused_symlink/ : /refused_export/);
    assert.equal(injected, true);
    assert.equal(liveWorktree, false);
    assert.ok(!existsSync(marker));
    const index = callGit(scratch, ['ls-files', '--stage'], {
      env: { ...env, GIT_DIR: join(scratch, 'export.git'), GIT_INDEX_FILE: join(scratch, 'index') },
    }).toString();
    assert.match(index, /^100644 [a-f0-9]+ 0\tsub\/answer\n$/);
  });
}

test('post-write export validation rejects a symlink mode', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-mode-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '--template=');
  const oid = git(dir, 'hash-object', '-w', '--', '.git/HEAD');
  git(dir, 'update-index', '--add', '--cacheinfo', `120000,${oid},link`);
  const tree = git(dir, 'write-tree');
  assert.doesNotThrow(() => verifyModes(Buffer.alloc(0)));
  const empty = execFileSync('git', ['mktree'], { cwd: dir, env, input: '' }).toString().trim();
  assert.throws(() => verifyModes(Buffer.from(git(dir, 'diff-tree', '--raw', '-r', '-z', empty, tree))), /refused_symlink/);
  assert.doesNotThrow(() => verifyModes(Buffer.from(git(dir, 'diff-tree', '--raw', '-r', '-z', tree, empty))));
});

test('a tracked directory swapped for a symlink is blocked before grading setup', t => {
  const { result, out, dir, outsideBefore } = fixture(t, 'symlink');
  assert.equal(digest(join(dir, 'outside')), outsideBefore);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^run  [\w.-]+  not_run  refused_symlink\n$/);
  assert.equal(readFileSync(join(dir, 'setup'), 'utf8'), 'absent\n', 'only pre-launch setup ran');
  assert.ok(!existsSync(join(dir, 'golden')));
  const row = json(out);
  assert.deepEqual(row.outcome, { state: 'blocked', reason: 'refused_symlink' });
  assert.deepEqual(row.check, { result: 'not_run', command: 'node' });
  assert.deepEqual(row.complexity.rating, rating);
  assert.equal(row.taskId, 'fixture');
  assert.equal(row.changes, null);
  assert.equal(json(join(dir, 'collector')).worktree, null);
});

test('a regular file at a golden parent records a refusal and skips grading setup', t => {
  const { result, out, dir } = fixture(t, 'golden-collision');
  assert.equal(result.status, 0, result.stderr);
  const row = json(out);
  assert.deepEqual(row.outcome, { state: 'blocked', reason: 'refused_export' });
  assert.deepEqual(row.check, { result: 'not_run', command: 'node' });
  assert.equal(row.changes, null);
  assert.equal(readFileSync(join(dir, 'setup'), 'utf8'), 'absent\n');
  assert.ok(!existsSync(join(dir, 'golden')));
});

for (const type of ['symlink', 'hardlink', 'directory', 'fifo', 'parent', 'outside', 'dotdot', 'dot', 'slash', 'run-tree']) {
  test(`runner rejects an unsafe output destination (${type}) before setup or launch`, t => {
    const { result, dir, launcher } = fixture(t, `out-${type}`);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /invalid suite output destination/);
    assert.equal(launcher, null);
    assert.ok(!existsSync(join(dir, 'setup')));
    if (type.endsWith('link')) assert.equal(readFileSync(join(dir, 'outside/other'), 'utf8'), 'untouched');
    if (type === 'parent' || type === 'outside') assert.ok(!existsSync(join(dir, 'outside/records.jsonl')));
    if (['dotdot', 'dot', 'slash'].includes(type)) assert.ok(!existsSync(join(dir, 'work/records.jsonl')));
    if (type === 'run-tree') assert.ok(!existsSync(join(dir, 'work/bench-previous/records.jsonl')));
  });
}

for (const mode of ['results-dir', 'default-out', 'default-work', 'out-parent-inside', 'out-root-file']) {
  test(`writes a record inside the results root (${mode})`, t => {
    const { result, out, dir, work, results, launcher } = fixture(t, mode);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(json(out).schema, 'bench-run@1');
    assert.ok(realpathSync(out).startsWith(results + '/'));
    if (mode === 'results-dir') assert.equal(lstatSync(results).mode & 0o777, 0o700);
    const trusted = readdirSync(work).find(name => name.startsWith('bench-trusted-'));
    assert.ok(trusted);
    for (const tree of [launcher.cwd, json(join(dir, 'golden')).cwd, json(join(dir, 'collector')).worktree, join(work, trusted)]) {
      assert.ok(!realpathSync(out).startsWith(tree + '/'));
      if (mode === 'results-dir') assert.ok(!tree.startsWith(results + '/'));
    }
  });
}

test('appends a row without opening the results file before launch', { skip: !existsSync('/proc/self/fd') }, t => {
  const { result, out, dir } = fixture(t, 'out-append');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(dir, 'open-count'), 'utf8'), '0');
  const [previous, appended, end] = readFileSync(out, 'utf8').split('\n');
  assert.deepEqual(JSON.parse(previous), { previous: true });
  assert.equal(JSON.parse(appended).schema, 'bench-run@1');
  assert.equal(end, '');
});

test('a sprite without an exit file times out before any golden file is restored', t => {
  const { result, out, sprites, dir, launcher } = fixture(t, 'no-rc');
  assert.ok(readdirSync(sprites).some(file => file.endsWith('.jsonl')), 'sprite did start');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.ok(!existsSync(join(launcher.cwd, 'checks/golden.cjs')));
  assert.ok(!existsSync(join(dir, 'golden')));
  assert.ok(!existsSync(out));
});

test('a launcher error reports exit 1 without a record', t => {
  const { result, out } = fixture(t, 'fail-start');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not produce a record/);
  assert.equal(result.stdout, '');
  assert.ok(!existsSync(out));
});

test('the work repo has one synthetic commit and none of the source commits', t => {
  const { result, launcher, base, goldenRef } = fixture(t, 'pass');
  assert.equal(result.status, 0, result.stderr);
  const cwd = launcher.cwd;
  assert.equal(git(cwd, 'rev-list', '--all', '--count'), '1');
  assert.equal(git(cwd, 'show', 'HEAD:answer'), 'base');
  assert.equal(git(cwd, 'remote'), '');
  for (const ref of [base, goldenRef]) {
    assert.equal(spawnSync('git', ['cat-file', '-e', ref], { cwd, env, stdio: 'ignore' }).status, 1);
  }
});
