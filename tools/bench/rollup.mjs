import { readFileSync, writeFileSync } from 'node:fs';
import { args, changeKeys, checks, clock, cli, count, fields, id, jsonl, levels, modelKey, print, proxyKeys, reasonCode, record, repo, requireThat, schema, seconds, states, sum, thinkingLevel, tokenKeys, validModel, validRating } from './record.mjs';

const string = x => typeof x === 'string';
const nullable = test => x => x === null || test(x);
const counts = (x, keys) => keys.every(key => x && nullable(count)(x[key]));
const usage = x => counts(x, ['turns', 'toolCalls', 'costMicros']) && counts(x.tokens, tokenKeys);
const coverages = ['complete', 'partial', 'none'];

function valid(r) {
  if (!(r?.schema === schema && id(r.runId) && usage(r)
    && ['parentId', 'taskId'].every(key => nullable(id)(r[key]))
    && nullable(repo)(r.repo) && nullable(thinkingLevel)(r.thinking)
    && Number.isFinite(clock(r.startedAt)) && clock(r.endedAt) >= clock(r.startedAt)
    && Number.isFinite(r.wallSeconds) && nullable(Number.isFinite)(r.activeSeconds)
    && states.includes(r.outcome?.state) && nullable(reasonCode)(r.outcome.reason)
    && (r.changes === null || changeKeys.every(k => count(r.changes?.[k]))) && counts(r, ['reviewRounds'])
    && [null, ...checks].includes(r.check?.result) && nullable(string)(r.check.command)
    && coverages.includes(r.coverage?.tokens) && counts(r.complexity?.proxies, proxyKeys)
    && nullable(validRating)(r.complexity.rating))) return false;
  if (r.level === 'sprite') return nullable(validModel)(r.model) && r.byModel === null && r.sprites === null;
  return levels.includes(r.level) && r.model === null && Array.isArray(r.byModel)
    && r.byModel.every(x => validModel(x) && usage(x)) && count(r.sprites?.count)
    && Number.isFinite(r.sprites.wallSeconds) && nullable(Number.isFinite)(r.sprites.activeSeconds);
}

const totals = rows => ({ ...fields(['turns', 'toolCalls', 'costMicros'], k => sum(rows, r => r[k])),
  tokens: fields(tokenKeys, k => sum(rows, r => r.tokens[k])) });

function summarize(input, o) {
  const unique = new Map(), groups = new Map(), runs = new Map();
  for (const r of input) {
    requireThat(valid(r), 'invalid bench record');
    if (!unique.has(r.runId)) unique.set(r.runId, r);
  }
  const parents = new Set([...unique.values()].map(r => r.parentId));
  const rows = [...unique.values()].filter(r => r.level === 'sprite' || !parents.has(r.runId));
  // A total passed beside its children is dropped; all its sprites must then be present, or the total would silently shrink.
  const physical = r => r.runId.replace(/~[1-9]\d*$/, '');
  for (const dropped of unique.values()) if (dropped.level !== 'sprite' && parents.has(dropped.runId)) {
    const under = new Set();
    for (const r of rows) {
      const seen = new Set();
      for (let at = r; at && !seen.has(at.runId); at = unique.get(at.parentId)) {
        seen.add(at.runId);
        if (r.level === 'sprite' && at.runId === dropped.runId) under.add(physical(r));
      }
    }
    requireThat(under.size === dropped.sprites.count, 'incomplete children');
  }
  for (const r of rows) {
    // Model slices share one physical sprite's time, changes and retry count.
    const key = r.level === 'sprite' ? `sprite:${r.runId.replace(/~[1-9]\d*$/, '')}` : `rollup:${r.runId}`;
    if (!runs.has(key)) runs.set(key, r);
    for (const u of r.byModel ?? (r.model ? [{ ...r, provider: r.model.provider, name: r.model.name }] : [])) {
      const { provider, name } = u;
      const key = modelKey(u);
      if (!groups.has(key)) groups.set(key, { provider, name, rows: [] });
      groups.get(key).rows.push(u);
    }
  }
  const sprites = [...runs.values()];
  const start = clock(o.started), end = clock(o.ended);
  requireThat(Number.isFinite(start) && end >= start);
  const r = record(o, o.id, o.level, start, end), tally = totals(rows);
  const complete = rows.length && rows.every(x => x.coverage.tokens === 'complete' && tokenKeys.every(k => x.tokens[k] !== null));
  const observed = Object.values(tally.tokens).some(x => x !== null);
  const coverage = !observed ? 'none' : complete && o.mobSession !== 'claude' ? 'complete' : 'partial';
  const active = sum(sprites, x => (x.sprites ?? x).activeSeconds);
  const proxies = fields(proxyKeys, k => sum(sprites, x => x.complexity.proxies[k]));
  proxies.reviewRounds = o.reviewRounds ?? proxies.reviewRounds;
  proxies.failedChecks = o.failedChecks ?? proxies.failedChecks;
  const result = { ...r, ...tally, coverage: { tokens: coverage },
    byModel: [...groups.values()].map(({ provider, name, rows }) => ({ provider, name, ...totals(rows) })),
    changes: sprites.some(x => x.changes) ? fields(changeKeys, k => sum(sprites, x => x.changes?.[k])) : null,
    reviewRounds: proxies.reviewRounds, complexity: { rating: o.rating ?? null, proxies },
    sprites: {
      count: sum(sprites, x => x.sprites?.count ?? 1) ?? 0,
      wallSeconds: seconds((sum(sprites, x => (x.sprites ?? x).wallSeconds) ?? 0) * 1000),
      activeSeconds: active === null ? null : seconds(active * 1000),
    },
  };
  return { result, contributors: rows.map(x => x.runId) };
}

export const rollup = (input, o) => summarize(input, o).result;

function main() {
  const [o, files] = args('level id started ended mob-session manifest', states);
  requireThat(files.length && levels.includes(o.level) && id(o.id));
  requireThat(o.mobSession == null || (o.level === 'mob' && ['claude', 'pi'].includes(o.mobSession)));
  const { result, contributors } = summarize(files.flatMap(file => jsonl(readFileSync(file, 'utf8'), true)), o);
  if (o.manifest != null) writeFileSync(o.manifest, JSON.stringify({ [o.id]: contributors }) + '\n', { flag: 'wx' });
  print([result]);
  return 0;
}
cli(import.meta.url, main, 'error: invalid roll-up arguments or bench records');
