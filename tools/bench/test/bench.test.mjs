import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseSprite } from '../sprite-usage.mjs';
import { rollup } from '../rollup.mjs';
import { sanitize } from './make-fixtures.mjs';

const fixtures = new URL('./fixtures/', import.meta.url);
const fixture = name => readFileSync(new URL(`${name}.jsonl`, fixtures), 'utf8');
const from = (name, options) => parseSprite(fixture(name), { name, rc: 0, ...options });
const lines = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const start = '2025-01-01T00:00:00.000Z', end = '2025-01-01T00:00:10.125Z';
const tokens = { in: 12, out: 4, reasoning: 2, cached: 7 };
const missing = { in: null, out: null, reasoning: null, cached: null };
const changes = { files: 1, linesAdded: 2, linesRemoved: 3 };
const proxies = { files: 1, lines: 5, reviewRounds: 2, failedChecks: 3, retries: 4 };
const options = { repo: 'acme/web', task: 't1', parent: 'mob1', reviewRounds: 2, failedChecks: 3,
  retries: 4, changes, check: 'pass', checkCommand: 'verify' };
const [session, { message: assistant }] = fixture('single').trim().split('\n').map(JSON.parse);
const at = offset => Date.parse(start) + offset;
const turn = props => ({ type: 'message_end', message: { ...assistant, ...props } });
const call = id => ({ type: 'toolCall', id });
const collector = t => {
  const { dir, sprite } = spriteLog(t, '');
  return text => {
    file(dir, 's.jsonl', text);
    const run = sprite();
    assert.equal(run.status, 0);
    return run.stdout.trim().split('\n').map(JSON.parse);
  };
};
const collectEvents = t => {
  const collect = collector(t);
  return (...events) => collect(lines([session, ...events]));
};
const scratch = t => {
  const dir = mkdtempSync(fileURLToPath(new URL('./bench-', import.meta.url)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const invoke = (script, ...args) => spawnSync(process.execPath,
  [fileURLToPath(new URL(`../${script}.mjs`, import.meta.url)), ...args], { encoding: 'utf8' });
const task = (input, ...args) => invoke('rollup', '--level', 'task', '--id', 'task1', '--started', start, '--ended', end, ...args, input);
const exited = (result, code) => assert.deepEqual([result.status, result.stdout], [code, '']);
const file = (dir, name, text) => { const path = join(dir, name); writeFileSync(path, text); return path; };

test('record has every bench-run field and expected value type', () => {
  assert.deepEqual(from('single', options), [{
    schema: 'bench-run@1', runId: 'single', level: 'sprite', parentId: 'mob1', taskId: 't1', repo: 'acme/web',
    model: { provider: 'p1', name: 'm1' }, byModel: null, thinking: 'low', startedAt: start,
    endedAt: '2025-01-01T00:00:02.000Z', wallSeconds: 2, activeSeconds: 2, turns: 1, toolCalls: 0,
    tokens, costMicros: 31, outcome: { state: 'done', reason: null }, changes, reviewRounds: 2,
    check: { result: 'pass', command: 'verify' }, coverage: { tokens: 'complete' },
    complexity: { rating: null, proxies }, sprites: null,
  }]);
});

test('served models get separate records and usage', () => {
  assert.deepEqual(from('multi').map(r => [r.runId, r.model, r.tokens]), [
    ['multi~1', { provider: 'p1', name: 'm1' }, tokens],
    ['multi~2', { provider: 'p1', name: 'm2' }, { ...tokens, in: 3 }],
  ]);
});

test('only message_end counts, once by response ID or fallback', t => {
  const collect = collector(t);
  const noise = n => ({ ...assistant, responseId: `r${n}`,
    usage: { ...assistant.usage, input: n, totalTokens: 30 + n, cost: { total: n / 1e6 } } });
  const rows = [
    ...collect(lines([session, turn({}), turn({ timestamp: at(3000) }),
      { type: 'message_update', message: noise(2), usage: noise(2).usage },
      { type: 'turn_end', message: noise(3) }, { type: 'agent_end', messages: [noise(4)] }])),
    ...collect(fixture('restart')), ...collect(lines([session, turn({ responseId: undefined }), turn({ responseId: undefined })])),
  ];
  assert.deepEqual(rows.map(r => [r.turns, r.tokens, r.costMicros]), Array(3).fill([1, tokens, 31]));
});

test('no assistant usage means null counts and cost', () => {
  const [r] = from('unknown');
  assert.deepEqual([r.tokens, r.costMicros, r.coverage.tokens], [missing, null, 'none']);
});

test('exit status and final assistant error determine outcome unless blocked', () => {
  for (const [rc, state, reason] of [[0, 'done', null], [124, 'failed', 'timeout'], [125, 'failed', 'idle'],
    [130, 'canceled', null], [137, 'canceled', null], [143, 'canceled', null], [4, 'failed', 'exit 4']]) {
    assert.deepEqual(from('single', { rc })[0].outcome, { state, reason });
  }
  assert.deepEqual(from('error')[0].outcome, { state: 'failed', reason: 'model_error' });
  assert.deepEqual(from('error', { outcome: 'blocked', reason: 'waiting' })[0].outcome, { state: 'blocked', reason: 'waiting' });
});

test('active time clips and subtracts the union of parallel tool waits', t => {
  const collect = collectEvents(t);
  const wait = (toolCallId, offset, durationMs) => [
    { type: 'tool_execution_end', toolCallId, durationMs },
    { type: 'message_end', message: { role: 'toolResult', toolCallId, timestamp: Date.parse(start) + offset } },
  ];
  const time = (first, second) => collect(turn({ content: [call('c1'), call('c2')] }),
    ...wait('c1', 4000, first), ...wait('c2', 6000, second))[0];
  const r = time(3000, 4000);
  assert.deepEqual([r.wallSeconds, r.activeSeconds, r.toolCalls], [6, 1, 2]);
  assert.equal(time(7000, 4000).activeSeconds, 0);
  assert.equal(time(undefined, 4000).activeSeconds, null);
});

test('tool calls belong to issuing turns and untimed calls make active time unknown', t => {
  const collect = collectEvents(t);
  const events = [turn({ content: [call('c1'), call('c1'), call('c2'), { type: 'text', id: 'c3' }] }),
    turn({ model: 'm2', responseId: 'r2', timestamp: at(3000) }),
    turn({ content: [call('c3')] }), // replay, not an issued call
    { type: 'tool_execution_end', toolCallId: 'c1', timestamp: at(4000), durationMs: 1000 },
    { type: 'tool_execution_start', toolCallId: 'c2', timestamp: at(4000) }];
  assert.deepEqual(collect(...events).map(r => [r.toolCalls, r.activeSeconds]), [[2, null], [0, null]]);
  const result = { type: 'message_end', message: { role: 'toolResult', toolCallId: 'c2', timestamp: at(6000), durationMs: 1000 } };
  assert.deepEqual(collect(...events, result).map(r => [r.toolCalls, r.activeSeconds]), [[2, 4], [0, 4]]);
});

test('thinking uses the last valid level of each model before the global fallback', t => {
  const collect = collectEvents(t);
  const change = thinkingLevel => ({ type: 'thinking_level_change', thinkingLevel });
  const turns = [turn({}), turn({ responseId: 'r2', thinkingLevel: 'x-high_2' }),
    turn({ responseId: 'r3', thinkingLevel: undefined }), turn({ responseId: 'r4', thinkingLevel: 'Bad!' }),
    turn({ model: 'm2', responseId: 'r5', thinkingLevel: undefined })];
  assert.deepEqual(collect(change('medium'), ...turns, change('off')).map(r => r.thinking), ['x-high_2', 'off']);
  assert.deepEqual(collect(...turns, change('Bad!')).map(r => r.thinking), ['x-high_2', null]);
  assert.equal(collect(turn({ thinkingLevel: 'x'.repeat(33) }))[0].thinking, null);
});

test('turn usage ignores invalid token fields without losing valid zeroes', t => {
  const collect = collectEvents(t);
  const [r] = collect(turn({ usage: { input: '12', output: -1, reasoning: 1.5, cacheRead: 2 ** 53 } }),
    turn({ responseId: 'r2', usage: { input: 3, output: 0 } }));
  assert.deepEqual([r.tokens, r.coverage.tokens], [{ ...missing, in: 3, out: 0 }, 'partial']);
  const [mixed] = collect(turn({ usage: { ...assistant.usage, reasoning: -1 } }), turn({ responseId: 'r2' }));
  assert.equal(mixed.coverage.tokens, 'partial');
});

test('cost rounds per turn and is null if any turn has invalid or missing cost', t => {
  const collect = collectEvents(t);
  const priced = (responseId, total) => turn({ responseId, usage: { cost: { total } } });
  assert.equal(collect(priced('r1', 0.0000006), priced('r2', 0.0000006))[0].costMicros, 2);
  for (const cost of [undefined, '0.000001', -0.000001]) {
    assert.equal(collect(priced('r1', 0.0000006), priced('r2', cost))[0].costMicros, null);
  }
});

test('roll-up keeps models, sums known leaves once, and uses its own clock', () => {
  const [a, b] = from('multi', options), [c] = from('unknown');
  const o = { level: 'task', id: 'task1', started: start, ended: end };
  const r = rollup([a, a, b, c], o);
  assert.deepEqual([r.model, r.turns, r.tokens, r.costMicros, r.wallSeconds, r.coverage.tokens],
    [null, 3, { in: 15, out: 8, reasoning: 4, cached: 14 }, 62, 10.125, 'partial']);
  assert.deepEqual(r.sprites, { count: 2, wallSeconds: 5, activeSeconds: 5 });
  assert.deepEqual(r.complexity.proxies, proxies);
  assert.deepEqual(r.byModel, [
    { provider: 'p1', name: 'm1', turns: 2, toolCalls: 0, costMicros: 31, tokens },
    { provider: 'p1', name: 'm2', turns: 1, toolCalls: 0, costMicros: 31, tokens: { ...tokens, in: 3 } },
  ]);
  const nested = rollup([r, r], { ...o, level: 'pr', id: 'pr1' });
  assert.deepEqual([nested.byModel, nested.sprites, nested.tokens, nested.coverage.tokens],
    [r.byModel, r.sprites, r.tokens, 'partial']);
  const unknown = rollup([c], o);
  assert.deepEqual([unknown.tokens, unknown.costMicros, unknown.coverage.tokens], [missing, null, 'none']);
  assert.equal(rollup([a], o).coverage.tokens, 'complete');
  assert.equal(rollup([a], { ...o, level: 'mob', mobSession: 'claude' }).coverage.tokens, 'partial');
});

test('fixtures and generator retain only safe fields and values', () => {
  for (const file of readdirSync(fixtures)) {
    const text = readFileSync(new URL(file, fixtures), 'utf8');
    const rows = text.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(JSON.parse(JSON.stringify(sanitize(text))), rows);
    JSON.stringify(rows, (key, value) => {
      if (typeof value === 'string') assert.match(value, /^(?!.*\b(?:prompt|token)\b)[^/\\]{0,64}$/i);
      return value;
    });
  }
  const input = { type: 'message_end', message: { role: 'assistant', content: 'sample', responseId: 'sample' } };
  assert.equal(lines(sanitize(lines([input]))), lines([{ type: 'message_end', message: { role: 'assistant', responseId: 'r1' } }]));
});

test('CLIs emit only records, distinguish running from missing, and reject invalid JSONL', t => {
  const dir = scratch(t);
  const sprite = name => invoke('sprite-usage', name, '--dir', dir);
  exited(sprite('missing'), 2);
  file(dir, 'multi.jsonl', fixture('multi'));
  exited(sprite('multi'), 3);
  file(dir, 'multi.rc', '0\n');
  mkdirSync(join(dir, 'multi'));
  file(join(dir, 'multi'), 'a', ''); file(join(dir, 'multi'), 'b', '');
  const run = sprite('multi');
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, lines(from('multi', { retries: 1 })), '']);
  const rolled = task(file(dir, 'runs.jsonl', run.stdout + run.stdout));
  assert.equal(rolled.status, 0);
  assert.equal(JSON.parse(rolled.stdout).turns, 2);
  exited(task(file(dir, 'bad.jsonl', run.stdout + '{"schema":"bench-run@1"}\n')), 2);
});

function spriteLog(t, text, rc = 0) {
  const dir = scratch(t);
  file(dir, 's.jsonl', text);
  file(dir, 's.rc', String(rc));
  return { dir, sprite: (...args) => invoke('sprite-usage', 's', '--dir', dir, ...args) };
}

test('a finished run without assistant turns survives collection and roll-up', t => {
  const { dir, sprite } = spriteLog(t, lines([session, { type: 'thinking_level_change', thinkingLevel: 'low' },
    { type: 'tool_execution_start', toolCallId: 'c1' },
    { type: 'tool_execution_end', toolCallId: 'c1', timestamp: at(2000), durationMs: 1000 }]), 124);
  const run = sprite();
  assert.equal(run.status, 0);
  const r = JSON.parse(run.stdout);
  assert.deepEqual([r.runId, r.model, r.thinking, r.turns, r.toolCalls, r.tokens, r.costMicros, r.coverage.tokens, r.outcome],
    ['s', null, null, 0, 1, missing, null, 'none', { state: 'failed', reason: 'timeout' }]);
  const rolled = task(file(dir, 'runs.jsonl', run.stdout));
  assert.equal(rolled.status, 0);
  const x = JSON.parse(rolled.stdout);
  assert.deepEqual([x.turns, x.toolCalls, x.byModel, x.sprites], [0, 1, [], { count: 1, wallSeconds: 2, activeSeconds: 1 }]);
});

test('collector accepts model identifiers and reason codes, not arbitrary strings', t => {
  const model = { provider: 'P-1', name: ['M:2.v_1', 'v2'].join('/') };
  const { dir, sprite } = spriteLog(t, lines([session, turn({ provider: model.provider, model: model.name })]));
  const good = sprite('--outcome', 'blocked', '--reason', 'WAIT_dep:2.1-a');
  assert.equal(good.status, 0);
  const r = JSON.parse(good.stdout);
  assert.deepEqual([r.model, r.outcome], [model, { state: 'blocked', reason: 'WAIT_dep:2.1-a' }]);
  for (const reason of ['Bad!', 'x'.repeat(81), ['a', 'b'].join('/'), 'please rerun the job', 'exit 1234']) {
    exited(sprite('--outcome', 'blocked', '--reason', reason), 2);
  }
  for (const props of [{ provider: 'Bad!' }, { model: 'x'.repeat(129) }]) {
    file(dir, 's.jsonl', lines([session, turn(props)]));
    exited(sprite(), 2);
  }
});

test('roll-up rejects malformed identifiers, metadata and counts', t => {
  const dir = scratch(t), [r] = from('single');
  const mob = rollup([r], { level: 'mob', id: 'mob1', started: start, ended: end });
  const invalid = [
    ...['runId', 'taskId', 'parentId', 'repo', 'thinking'].map(k => [r, { [k]: 'Bad!' }]),
    [r, { runId: 123 }], [r, { outcome: { state: 'blocked', reason: 'Bad!' } }],
    [r, { complexity: { ...r.complexity, rating: { score: 1, size: 'S', reason: 'small', ratedBy: 'Bad!', ratedAt: start } } }],
    [r, { model: { ...r.model, name: 'Bad!' } }], [r, { model: { ...r.model, provider: 'Bad!' } }],
    [mob, { byModel: [{ ...mob.byModel[0], provider: 'Bad!' }] }],
    [r, { turns: -1 }], [r, { turns: 1.5 }], [r, { tokens: { ...r.tokens, in: '12' } }],
    [r, { costMicros: 2 ** 53 }], [r, { changes: { ...changes, files: -1 } }],
    [mob, { sprites: { ...mob.sprites, count: -1 } }],
  ];
  for (const [row, patch] of invalid) {
    exited(task(file(dir, 'runs.jsonl', lines([{ ...row, ...patch }]))), 2);
  }
});

test('mixed roll-up levels count only contributing rows and record their IDs', t => {
  const dir = scratch(t), [a, b] = from('multi', options);
  const mob = rollup([a, b], { level: 'mob', id: 'mob1', parent: 'group1', started: start, ended: end });
  const group = rollup([mob], { level: 'task', id: 'group1', started: start, ended: end });
  const manifest = join(dir, 'sources.json');
  const run = task(file(dir, 'runs.jsonl', lines([group, mob, a, a, b])), '--manifest', manifest);
  assert.equal(run.status, 0);
  const r = JSON.parse(run.stdout);
  assert.deepEqual([r.tokens, r.byModel, r.sprites], [mob.tokens, mob.byModel, mob.sprites]);
  assert.deepEqual(JSON.parse(readFileSync(manifest, 'utf8')), { task1: [a.runId, b.runId] });
});

test('Claude mob coverage stays none when no tokens were measured', t => {
  const dir = scratch(t);
  const run = invoke('rollup', '--level', 'mob', '--id', 'mob1', '--started', start, '--ended', end,
    '--mob-session', 'claude', file(dir, 'runs.jsonl', lines(from('unknown'))));
  assert.equal(run.status, 0);
  const r = JSON.parse(run.stdout);
  assert.deepEqual([r.tokens, r.coverage.tokens], [missing, 'none']);
});

test('base accepts a single commit, not a range, tree or option', t => {
  const { sprite } = spriteLog(t, fixture('single'));
  const worktree = fileURLToPath(new URL('../../../', import.meta.url));
  const diff = base => sprite('--worktree', worktree, `--base=${base}`);
  const good = diff('HEAD');
  assert.equal(good.status, 0);
  assert.ok(Number.isSafeInteger(JSON.parse(good.stdout).changes.files));
  for (const base of ['--cached', 'HEAD..HEAD', 'HEAD^{tree}']) exited(diff(base), 2);
});

function churnFixture(t) {
  const { dir } = spriteLog(t, fixture('single'));
  const work = join(dir, 'work');
  mkdirSync(work);
  const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: work, env, stdio: 'ignore' }).status, 0);
  git('init', '--template=');
  file(work, 'answer', 'before\n');
  git('add', 'answer');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Fixture');
  const measure = (config = {}, path = work) => {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../sprite-usage.mjs', import.meta.url)),
      's', '--dir', dir, '--worktree', path, '--base', 'HEAD'], { env: { ...env, ...config }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout).changes;
  };
  return { dir, work, git, measure };
}

for (const attrs of ['answer -diff', '* -diff', '* diff=custom', '* text eol=crlf']) {
  test(`churn ignores patched attributes (${attrs})`, t => {
    const { work, git, measure } = churnFixture(t);
    file(work, 'answer', 'after\n');
    file(work, '.gitattributes', `${attrs}\n`);
    if (attrs === '* diff=custom') git('config', 'diff.custom.binary', 'true');
    git('add', '.gitattributes', 'answer');
    const expected = { files: 2, linesAdded: 2, linesRemoved: 1 };
    assert.deepEqual(measure(), expected);
    if (attrs === '* text eol=crlf') {
      // Back to the original text, but with a different line ending. The
      // patched attribute must not normalize away this unstaged edit.
      file(work, 'answer', 'before\r\n');
      assert.deepEqual(measure(), expected);
    }
  });
}

test('churn counts a rename as add plus delete despite host git configuration', t => {
  const { dir, work, git, measure } = churnFixture(t);
  renameSync(join(work, 'answer'), join(work, 'renamed'));
  git('add', '--all');
  const sub = join(work, 'sub');
  mkdirSync(sub);
  const config = file(dir, 'gitconfig', '[diff]\n\trenames = true\n\trelative = true\n');
  const expected = { files: 2, linesAdded: 1, linesRemoved: 1 };
  assert.deepEqual(measure(), expected);
  for (const overrides of [{ GIT_CONFIG_GLOBAL: config }, { GIT_CONFIG_SYSTEM: config }, {
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'diff.renames', GIT_CONFIG_VALUE_0: 'true',
    GIT_CONFIG_KEY_1: 'diff.relative', GIT_CONFIG_VALUE_1: 'true',
  }]) assert.deepEqual(measure(overrides, sub), expected);
});

test('retries count only regular session files and are null without them', t => {
  const { dir, sprite } = spriteLog(t, fixture('single'));
  const retries = () => JSON.parse(sprite().stdout).complexity.proxies.retries;
  assert.equal(retries(), null);
  const sessionDir = join(dir, 's');
  mkdirSync(sessionDir);
  assert.equal(retries(), null);
  mkdirSync(join(sessionDir, 'sub'));
  file(sessionDir, 'a', '');
  symlinkSync('a', join(sessionDir, 'link'));
  assert.equal(retries(), 0);
  file(sessionDir, 'b', '');
  assert.equal(retries(), 1);
});

test('a sprite record carries the brief author\'s rating, and an invalid rating is refused', t => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'one.jsonl'), fixture('single'));
  writeFileSync(join(dir, 'one.rc'), '0\n');
  const rate = score => spawnSync(process.execPath, [fileURLToPath(new URL('../sprite-usage.mjs', import.meta.url)), 'one',
    '--dir', dir, '--complexity-score', score, '--complexity-size', 'M', '--complexity-reason', 'one small module',
    '--rated-by', 'author', '--rated-at', '2025-01-01T00:00:00Z'], { encoding: 'utf8' });
  const ok = rate('3');
  assert.deepEqual([ok.status, JSON.parse(ok.stdout).complexity.rating], [0, {
    score: 3, size: 'M', reason: 'one small module', ratedBy: 'author', ratedAt: '2025-01-01T00:00:00.000Z' }]);
  assert.deepEqual([rate('9').status, rate('9').stdout], [2, '']);
});

test('a check name takes no arguments, and a reason is a code, not prose', t => {
  const { sprite } = spriteLog(t, lines([session, turn({})]));
  for (const name of ['pnpm check', 'vitest', 'pnpm test']) {
    assert.equal(sprite('--check', 'pass', '--check-command', name).status, 0, name);
  }
  for (const name of ['deploy dummy-token', 'pnpm check --token x', 'node run.mjs', 'a b c']) {
    exited(sprite('--check', 'pass', '--check-command', name), 2);
  }
});

test('counts that stop being exact refuse the run instead of emitting a wrong total', t => {
  const big = Number.MAX_SAFE_INTEGER;
  const { sprite } = spriteLog(t, lines([session,
    turn({ responseId: 'a', usage: { ...assistant.usage, input: big } }),
    turn({ responseId: 'b', usage: { ...assistant.usage, input: 2 } })]));
  exited(sprite(), 2);
});

test('a total passed with only some of its children is refused, with all of them it counts once', t => {
  const dir = scratch(t);
  const [s1] = from('single', { name: 's1', parent: 'mob1' }), [s2] = from('single', { name: 's2', parent: 'mob1' });
  const mob = rollup([s1, s2], { level: 'mob', id: 'mob1', started: start, ended: end });
  exited(task(file(dir, 'part.jsonl', lines([mob, s1]))), 2);
  const full = task(file(dir, 'full.jsonl', lines([mob, s1, s2])));
  assert.equal(full.status, 0);
  assert.deepEqual(JSON.parse(full.stdout).tokens, mob.tokens);
});
