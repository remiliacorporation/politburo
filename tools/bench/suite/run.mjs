import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fields, requireThat, thinkingLevel, validModel, validRating } from '../record.mjs';
import { baseSetsEncoding, exportPatch, refusedEncoding, refusedSymlink } from './export.mjs';
import { childEnv } from './child-env.mjs';

const PREFIX = 'bench', SUITE = 'tools/bench/suite';
const slug = value => value == null ? 'default' : value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
export function runName(id, model, thinking, rep, unixSeconds) {
  return `${PREFIX}.${slug(id)}.${slug(model)}.${slug(thinking)}.r${rep}.${unixSeconds}`;
}

const sha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const text = x => typeof x === 'string' && x.trim() && !/[\0\r\n]/.test(x);
const argv = x => Array.isArray(x) && text(x[0]) && x.every(s => typeof s === 'string' && !s.includes('\0'));
const treePath = x => text(x) && x.split('/').every(part => /^[a-z0-9_.-]+$/i.test(part)
  && !['.', '..', '.git'].includes(part.toLowerCase()));
const integer = (x, min = 1) => /^\d+$/.test(String(x)) && Number.isSafeInteger(Number(x)) && Number(x) >= min;
const quiet = { stdio: 'ignore' };
const capture = { stdio: ['ignore', 'pipe', 'ignore'] };
const buffered = { maxBuffer: 64 * 1024 * 1024 };
const pipeInput = { stdio: ['pipe', 'pipe', 'ignore'] };
const goldenName = ([bin, ...args]) => bin === 'pnpm' && args.includes('exec') ? args[args.indexOf('exec') + 1] : bin;

function privateDir(work, prefix) {
  const dir = mkdtempSync(join(work, prefix));
  chmodSync(dir, 0o700);
  return dir;
}

function runChildEnv(work, o) {
  const home = privateDir(work, 'bench-home-');
  return childEnv({ HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'),
    XDG_DATA_HOME: join(home, 'data'), PI_MODEL: o.model, PI_THINKING: o.thinking },
  (process.env.BENCH_PASS_ENV ?? '').split(','));
}

function loadTask(repo, id, git) {
  const matches = JSON.parse(readFileSync(join(repo, SUITE, 'tasks.json'), 'utf8')).filter(x => x.id === id);
  const [task] = matches;
  requireThat(matches.length === 1 && /^[a-z0-9][a-z0-9-]*$/.test(id) && text(task.title)
    && sha(task.base) && sha(task.goldenRef) && task.base !== task.goldenRef
    && task.briefFile === `${SUITE}/briefs/${id}.md`
    && Array.isArray(task.goldenFiles) && task.goldenFiles.length && task.goldenFiles.every(treePath)
    && new Set(task.goldenFiles).size === task.goldenFiles.length
    && argv(task.goldenCommand) && /^[a-z0-9_.-]+$/i.test(goldenName(task.goldenCommand) ?? '')
    && Array.isArray(task.setup) && task.setup.every(argv)
    && Number.isSafeInteger(task.timeCapSeconds) && integer(task.timeCapSeconds)
    && validRating(task.rating) && task.rating.ratedBy === '218-BEE7'
    && text(task.rating.reason) && !/[\\/]/.test(task.rating.reason));
  for (const ref of [task.base, task.goldenRef]) requireThat(git(repo, ['cat-file', '-t', ref]).toString().trim() === 'commit');
  requireThat(git(repo, ['rev-parse', `${task.goldenRef}^1`]).toString().trim() === task.base);
  for (const file of task.goldenFiles) {
    requireThat(git(repo, ['cat-file', '-t', `${task.goldenRef}:${file}`]).toString().trim() === 'blob');
    let status = 0;
    try { git(repo, ['cat-file', '-e', `${task.base}:${file}`]); }
    catch (error) { status = error.status; }
    requireThat(status === 128);
  }
  requireThat(readFileSync(join(repo, task.briefFile), 'utf8').trim());
  return task;
}

async function reserveName(o, sprites) {
  for (;;) {
    const name = runName(o.task, o.model, o.thinking, Number(o.rep ?? 1), Math.floor(Date.now() / 1000));
    const prefix = join(sprites, name), lock = `${prefix}.bench-lock`;
    try { mkdirSync(lock); }
    catch (e) { if (e.code !== 'EEXIST') throw e; await sleep(100); continue; }
    if (!['', '.rc', '.jsonl', '.out'].some(suffix => existsSync(prefix + suffix))) return { name, prefix, lock };
    rmdirSync(lock);
    await sleep(100);
  }
}

function goldenPath(cwd, file) {
  requireThat(realpathSync(cwd) === cwd);
  let dir = cwd;
  for (const part of file.split('/').slice(0, -1)) {
    dir = join(dir, part);
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (stat) requireThat(stat.isDirectory());
    else mkdirSync(dir);
  }
  return join(cwd, file);
}

function unlinkIfPresent(file) {
  try { unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

function cloneWithPatch(work, prefix, trusted, patch, git) {
  const cwd = privateDir(work, prefix);
  git(cwd, ['clone', '--no-hardlinks', '--no-local', '--template=', trusted, '.']);
  if (patch.length) git(cwd, ['apply', '--binary', '--index', '--whitespace=nowarn'], { ...pipeInput, input: patch });
  return cwd;
}

const inside = (root, path) => path.startsWith(root.endsWith(sep) ? root : root + sep);
// Per-run directories are all fresh bench-* siblings under work. Never put
// results in that namespace, including when reopening an earlier work root.
const inRunTree = (work, path) => inside(work, path) && path.slice(work.length).split(sep).filter(Boolean)[0]?.startsWith('bench-');

function outputPath({ path, results, work }) {
  const parent = realpathSync(dirname(path));
  const target = join(parent, basename(path));
  requireThat(inside(results, target) && !inRunTree(work, parent));
  const entry = lstatSync(target, { throwIfNoEntry: false });
  requireThat(!entry || (entry.isFile() && entry.nlink === 1));
  accessSync(entry ? target : parent, constants.W_OK);
  return target;
}

function appendOutput(out, rows) {
  const path = outputPath(out);
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
    | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const entry = fstatSync(fd);
    requireThat(entry.isFile() && entry.nlink === 1 && inside(out.results, realpathSync(path)));
    const current = lstatSync(path);
    requireThat(current.dev === entry.dev && current.ino === entry.ino);
    for (let offset = 0; offset < rows.length;) offset += writeSync(fd, rows, offset, rows.length - offset);
  } finally { closeSync(fd); }
}

function prepareOutput(o, work) {
  let results = work;
  if (o['results-dir']) {
    const path = resolve(o['results-dir']);
    results = join(realpathSync(dirname(path)), basename(path));
    requireThat(!inRunTree(work, results));
    mkdirSync(results, { mode: 0o700 });
    chmodSync(results, 0o700);
  }
  requireThat(o.out == null || (!o.out.split(sep).includes('..') && !o.out.endsWith(sep) && basename(o.out) !== '.'));
  const out = { path: resolve(o.out ?? join(results, 'results.jsonl')), results, work };
  outputPath(out);
  return out;
}

function collect({ name, sprites, task, env, out }, check, churn, note) {
  const { score, size, reason, ratedBy, ratedAt } = task.rating;
  const collector = fileURLToPath(new URL('../sprite-usage.mjs', import.meta.url));
  const rows = execFileSync(process.execPath, [collector, name, '--dir', sprites, ...churn,
    '--task', task.id, '--check', check, '--check-command', goldenName(task.goldenCommand),
    '--complexity-score', String(score), '--complexity-size', size, '--complexity-reason', reason,
    '--rated-by', ratedBy, '--rated-at', ratedAt], { env, ...capture });
  appendOutput(out, rows);
  console.log(`run  ${name}  ${check}${note ? `  ${note}` : ''}`);
  return 0;
}

async function run(o, repo, task, grace, work, git, env, out, beforeLaunch) {
  // A known encoding base still needs a sprite log for the blocked record,
  // but must not run task setup. Export also checks S, which includes setup.
  const encodingBase = baseSetsEncoding(task.base, args => git(repo, args, buffered));
  const sprites = resolve(o.sprites ?? join(sep, 'tmp', 'sprites'));
  mkdirSync(sprites, { recursive: true });
  const dir = privateDir(work, 'bench-'), sprite = join(dir, 'tree');
  mkdirSync(sprite);
  const archive = git(repo, ['archive', task.base], buffered);
  const setup = cwd => {
    for (const [cmd, ...args] of task.setup) execFileSync(cmd, args, { cwd, env, ...quiet });
  };
  const initBase = cwd => {
    execFileSync('tar', ['-xf', '-'], { cwd, env, input: archive, stdio: ['pipe', 'ignore', 'ignore'] });
    git(cwd, ['init', '--template=']);
    git(cwd, ['add', '-f', '--all']);
    if (!encodingBase) {
      setup(cwd);
      // Tracked setup output belongs to the base, not to the sprite's changes.
      git(cwd, ['add', '--all']);
    }
    git(cwd, ['-c', 'user.name=Benchmark', '-c', 'user.email=bench@example.invalid',
      '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '--no-gpg-sign', '-m', 'Benchmark base']);
    return git(cwd, ['rev-parse', 'HEAD']).toString().trim();
  };
  const base = initBase(sprite);
  const trustedDir = privateDir(work, 'bench-trusted-'), trusted = join(trustedDir, 'trusted.git');
  git(trustedDir, ['clone', '--bare', '--no-hardlinks', '--no-local', '--template=', sprite, trusted]);
  const brief = join(dir, 'brief.md');
  copyFileSync(join(repo, task.briefFile), brief);
  const launcher = process.env.BENCH_SPRITE_START ? resolve(process.env.BENCH_SPRITE_START) : 'sprite-start';
  const { name, prefix, lock } = await reserveName(o, sprites);
  try {
    const cap = Number(o['max-seconds'] ?? task.timeCapSeconds), wait = (cap + grace) * 1000;
    const launcherEnv = runChildEnv(work, o);
    beforeLaunch?.();
    const deadline = performance.now() + wait;
    execFileSync(launcher, [name, brief, String(cap)], { cwd: sprite, env: launcherEnv, timeout: wait, ...quiet });
    while (!existsSync(`${prefix}.rc`)) {
      if (performance.now() >= deadline) return 1;
      await sleep(Math.min(100, deadline - performance.now()));
    }
    const measurement = { name, sprites, task, env, out };
    let stats, cwd, skipped;
    try {
      const exported = exportPatch(privateDir(work, 'bench-export-'), sprite, trusted, base, git,
        { sourceEncoding: encodingBase });
      skipped = exported.skipped;
      stats = cloneWithPatch(work, 'bench-stats-', trusted, exported.patch, git);
      cwd = cloneWithPatch(work, 'bench-grade-', trusted, exported.patch, git);
      for (const file of task.goldenFiles) {
        const target = goldenPath(cwd, file);
        const entry = lstatSync(target, { throwIfNoEntry: false });
        requireThat(!entry || entry.isFile());
        unlinkIfPresent(target);
        writeFileSync(target, git(repo, ['show', `${task.goldenRef}:${file}`]), { flag: 'wx' });
      }
    } catch (error) {
      const reason = [refusedSymlink, refusedEncoding].includes(error.message) ? error.message : 'refused_export';
      return collect(measurement, 'not_run', ['--outcome', 'blocked', '--reason', reason], reason);
    }
    setup(cwd);
    const [cmd, ...args] = task.goldenCommand;
    const verdict = spawnSync(cmd, args, { cwd, env, ...quiet });
    if (verdict.error) throw verdict.error;
    const check = verdict.status === 0 ? 'pass' : 'fail';
    return collect(measurement, check, ['--worktree', stats, '--base', base], skipped ? `skipped_special=${skipped}` : '');
  } finally { rmdirSync(lock); }
}

export async function runSuite({ args = process.argv.slice(2), beforeLaunch } = {}) {
  let o, repo, grace;
  try {
    ({ values: o } = parseArgs({ args, options: fields('task model thinking rep out work results-dir sprites max-seconds'.split(' '), () => ({ type: 'string' })) }));
    const slash = o.model?.indexOf('/') ?? -1;
    grace = Number(process.env.BENCH_RC_GRACE_SECONDS ?? 60);
    requireThat(o.task && (o.model == null || (slash > 0 && validModel({ provider: o.model.slice(0, slash), name: o.model.slice(slash + 1) })))
      && (o.thinking == null || thinkingLevel(o.thinking)) && integer(o.rep ?? 1) && integer(o['max-seconds'] ?? 1)
      && [o.out, o.work, o['results-dir'], o.sprites].every(x => x == null || text(x)) && integer(grace, 0) && grace <= 60);
    repo = resolve(process.env.BENCH_REPO ?? fileURLToPath(new URL('../../../', import.meta.url)));
  } catch { console.error('error: invalid suite arguments or manifest'); return 2; }
  try {
    let work, out;
    try {
      const requestedWork = resolve(o.work ?? join(tmpdir(), 'bench-suite'));
      mkdirSync(requestedWork, { recursive: true, mode: 0o700 });
      if (o.work == null) {
        const entry = lstatSync(requestedWork);
        requireThat(entry.isDirectory() && entry.uid === process.getuid() && (entry.mode & 0o777) === 0o700);
      }
      work = realpathSync(requestedWork);
      out = prepareOutput(o, work);
    } catch { console.error('error: invalid suite output destination'); return 2; }
    const env = runChildEnv(work, o);
    const gitEnv = (dir, workTree) => ({ ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1',
      ...(dir && { GIT_DIR: dir, GIT_INDEX_FILE: join(dirname(dir), 'index'), GIT_OBJECT_DIRECTORY: join(dir, 'objects') }),
      ...(workTree && { GIT_WORK_TREE: workTree }) });
    const git = (cwd, args, options, dir, workTree) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
      { ...capture, ...options, cwd, env: gitEnv(dir, workTree) });
    let task;
    try { task = loadTask(repo, o.task, git); }
    catch { console.error('error: invalid suite arguments or manifest'); return 2; }
    return await run(o, repo, task, grace, work, git, env, out, beforeLaunch);
  } catch { console.error('error: benchmark run did not produce a record'); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runSuite();
