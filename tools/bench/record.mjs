import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const schema = 'bench-run@1';
export const levels = ['mob', 'task', 'pr', 'spawner'];
export const states = ['done', 'failed', 'blocked', 'canceled'];
export const checks = ['pass', 'fail', 'not_run'];
export const tokenKeys = ['in', 'out', 'reasoning', 'cached'];
export const changeKeys = ['files', 'linesAdded', 'linesRemoved'];
export const proxyKeys = ['files', 'lines', 'reviewRounds', 'failedChecks', 'retries'];
export const fields = (keys, get) => Object.fromEntries(keys.map(key => [key, get(key)]));
export const jsonl = (text, strict = false) => {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return (strict ? lines : lines.filter(line => line.trim())).map(line => JSON.parse(line));
};
export const clock = s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(s) ? Date.parse(s) : NaN;
const matches = re => x => typeof x === 'string' && re.test(x);
export const id = matches(/^(?:[\w.~:-]+|[\w.-]+\/[\w.-]+#\d+)$/);
export const repo = matches(/^[\w.-]+\/[\w.-]+$/);
export const thinkingLevel = matches(/^[a-z0-9][a-z0-9_-]{0,31}$/);
// A short code: `exit 124`, or one word of letters, digits and _ . : -. Never prose.
export const reasonCode = matches(/^(?:exit \d{1,3}|[a-z0-9][a-z0-9_.:-]{0,79})$/i);
// A check name, optionally followed by `check` or `test` (`pnpm check`). Never arguments.
export const checkName = matches(/^[a-z0-9][a-z0-9_.:-]{0,59}(?: (?:check|test))?$/i);
const modelName = matches(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/);
export const validModel = x => x != null && modelName(x.provider) && modelName(x.name);
export const count = x => Number.isSafeInteger(x) && x >= 0;
export const validRating = r => r && [1, 2, 3, 4, 5].includes(r.score) && ['S', 'M', 'L'].includes(r.size)
  && typeof r.reason === 'string' && id(r.ratedBy) && Number.isFinite(clock(r.ratedAt));
export const iso = ms => new Date(ms).toISOString();
export const seconds = ms => Math.round(ms) / 1000;
export const elapsed = (start, end) => seconds(end - start);
export const modelKey = ({ provider, name }) => JSON.stringify([provider, name]);
export const add = (a, b) => {
  if (a == null || b == null) return a ?? b ?? null;
  const total = a + b;
  // Counts that stop being exact would be wrong in a record: refuse the run.
  if (Number.isInteger(a) && Number.isInteger(b) && !Number.isSafeInteger(total)) throw new RangeError('count overflow');
  return total;
};
export const sum = (items, get) => items.reduce((total, item) => add(total, get(item)), null);
export const proxies = (changes, reviewRounds, failedChecks, retries) => ({
  files: changes?.files ?? null, lines: changes ? changes.linesAdded + changes.linesRemoved : null,
  reviewRounds, failedChecks, retries,
});

export function record(o, runId, level, start, end) {
  return {
    schema, runId, level, parentId: o.parent ?? null, taskId: o.task ?? null, repo: o.repo ?? null,
    model: null, byModel: null, thinking: null, startedAt: iso(start), endedAt: iso(end),
    wallSeconds: elapsed(start, end), activeSeconds: null, turns: null, toolCalls: null,
    tokens: fields(tokenKeys, () => null), costMicros: null,
    outcome: { state: o.outcome ?? 'done', reason: o.reason ?? null }, changes: null,
    reviewRounds: o.reviewRounds ?? null, check: { result: o.check ?? null, command: o.checkCommand ?? null },
    coverage: { tokens: 'none' }, complexity: { rating: o.rating ?? null, proxies: proxies(null, null, null, null) },
    sprites: null,
  };
}

export function requireThat(ok, message = 'invalid arguments') {
  if (!ok) throw new Error(message);
}

const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
export function args(extra, outcomeStates) {
  const keys = 'repo parent task outcome reason review-rounds failed-checks check check-command complexity-score complexity-size complexity-reason rated-by rated-at ' + extra;
  const { values, positionals } = parseArgs({
    options: fields(keys.split(' '), () => ({ type: 'string' })), allowPositionals: true,
  });
  const o = Object.fromEntries(Object.entries(values).map(([k, v]) => [camel(k), v]));
  for (const key of ['reviewRounds', 'failedChecks']) if (o[key] != null) {
    requireThat(/^\d+$/.test(o[key]) && Number.isSafeInteger(Number(o[key])));
    o[key] = Number(o[key]);
  }
  requireThat(o.repo == null || repo(o.repo));
  requireThat(o.parent == null || id(o.parent));
  requireThat(o.task == null || id(o.task));
  requireThat(o.outcome == null || outcomeStates.includes(o.outcome));
  requireThat(o.reason == null ? o.outcome !== 'blocked' : o.outcome && reasonCode(o.reason));
  requireThat(o.check == null || checks.includes(o.check));
  requireThat(!o.checkCommand || o.check);
  requireThat(!o.checkCommand || checkName(o.checkCommand));
  for (const key of ['checkCommand', 'complexityReason']) {
    requireThat(o[key] == null || (o[key].trim() && !/[\r\n/\\]/.test(o[key])));
  }
  const rating = { score: Number(o.complexityScore), size: o.complexitySize,
    reason: o.complexityReason, ratedBy: o.ratedBy, ratedAt: o.ratedAt };
  if ([o.complexityScore, rating.size, rating.reason, rating.ratedBy, rating.ratedAt].some(x => x != null)) {
    requireThat(validRating(rating));
    o.rating = { ...rating, ratedAt: new Date(clock(rating.ratedAt)).toISOString() };
  }
  return [o, positionals];
}

export function cli(url, main, error) {
  if (!process.argv[1] || url !== pathToFileURL(process.argv[1]).href) return;
  try { process.exitCode = main(); }
  catch { console.error(error); process.exitCode = 2; }
}

export const print = records => { for (const r of records) console.log(JSON.stringify(r)); };
