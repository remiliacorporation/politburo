import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { childEnv } from './suite/child-env.mjs';
import { args, changeKeys, cli, count, fields, jsonl, modelKey, print, proxies, record, requireThat, seconds, sum, thinkingLevel, tokenKeys, validModel } from './record.mjs';

const usageKeys = { in: 'input', out: 'output', reasoning: 'reasoning', cached: 'cacheRead' };
const timestamp = x => typeof x === 'string' ? Date.parse(x) : Number.isFinite(x) ? x : NaN;

export function spriteOutcome(rc, stopReason) {
  if (rc === 0) return stopReason === 'error' ? { state: 'failed', reason: 'model_error' } : { state: 'done', reason: null };
  if ([130, 137, 143].includes(rc)) return { state: 'canceled', reason: null };
  return { state: 'failed', reason: ({ 124: 'timeout', 125: 'idle' })[rc] ?? `exit ${rc}` };
}

const validTime = (at, duration) => Number.isFinite(at) && Number.isFinite(duration) && duration >= 0;

function activeTime(start, end, calls, tools) {
  const intervals = [];
  for (const id of calls) {
    const { resultAt, resultWait, execution } = tools.get(id) ?? {};
    const [at, duration] = resultWait ?? [execution?.at ?? resultAt, execution?.duration];
    if (!validTime(at, duration)) return null;
    const lo = Math.max(start, at - duration), hi = Math.min(end, at);
    if (lo < hi) intervals.push([lo, hi]);
  }
  let active = end - start, cursor = start;
  for (const [lo, hi] of intervals.sort((a, b) => a[0] - b[0])) {
    active -= Math.max(0, hi - Math.max(cursor, lo));
    cursor = Math.max(cursor, hi);
  }
  return seconds(active);
}

export function parseSprite(text, o) {
  const models = new Map(), tools = new Map(), seen = new Set();
  const tool = id => {
    if (!tools.has(id)) tools.set(id, {});
    return tools.get(id);
  };
  let start, end = -Infinity, thinking = null, stopReason;
  for (const e of jsonl(text)) {
    const m = e.message;
    const messages = [m, ...(e.toolResults ?? []), ...(e.messages ?? [])];
    for (const t of [e.timestamp, ...messages.map(x => x?.timestamp)].map(timestamp)) {
      if (Number.isFinite(t)) end = Math.max(end, t);
    }
    if (e.type === 'session') start ??= timestamp(e.timestamp);
    if (e.type === 'thinking_level_change') thinking = thinkingLevel(e.thinkingLevel) ? e.thinkingLevel : null;
    if (e.type === 'message_end' && m?.role === 'assistant') {
      const model = { provider: m.provider, name: m.model };
      requireThat(validModel(model));
      const id = m.responseId || JSON.stringify([m.provider, m.model, m.timestamp, m.usage?.totalTokens]);
      if (!seen.has(id)) {
        const key = modelKey(model);
        if (!models.has(key)) models.set(key, { model, turns: [], calls: new Set() });
        const current = models.get(key);
        current.turns.push(m);
        if (thinkingLevel(m.thinkingLevel)) current.thinking = m.thinkingLevel;
        for (const item of Array.isArray(m.content) ? m.content : []) {
          if (item?.type === 'toolCall' && item.id != null) current.calls.add(item.id);
        }
        stopReason = m.stopReason;
        seen.add(id);
      }
    }
    if (e.toolCallId != null && ['tool_execution_start', 'tool_execution_end'].includes(e.type)) {
      const timing = tool(e.toolCallId);
      if (e.type === 'tool_execution_end' && Number.isFinite(e.durationMs) && e.durationMs >= 0) {
        const at = timestamp(e.timestamp);
        if (Number.isFinite(at) || !timing.execution) {
          timing.execution = { at: Number.isFinite(at) ? at : undefined, duration: e.durationMs };
        }
      }
    }
    for (const result of messages.filter(x => x?.role === 'toolResult' && x.toolCallId != null)) {
      const timing = tool(result.toolCallId), at = timestamp(result.timestamp);
      if (Number.isFinite(at)) timing.resultAt = at;
      if (validTime(at, result.durationMs)) timing.resultWait = [at, result.durationMs];
    }
  }
  requireThat(Number.isFinite(start) && end >= start);
  if (!models.size) models.set(null, { model: null, turns: [], calls: new Set(tools.keys()) });
  const rows = [...models.values()];
  const activeSeconds = activeTime(start, end, new Set(rows.flatMap(r => [...r.calls])), tools);
  return rows.map(({ model, turns, calls, thinking: lastThinking }, i) => {
    const r = record(o, rows.length === 1 ? o.name : `${o.name}~${i + 1}`, 'sprite', start, end);
    const usage = turns.map(m => fields(tokenKeys, k => {
      const value = m.usage?.[usageKeys[k]];
      return count(value) ? value : null;
    }));
    const tokens = fields(tokenKeys, k => sum(usage, u => u[k]));
    const costs = turns.map(m => {
      const cost = m.usage?.cost?.total;
      return Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 1e6) : null;
    });
    const coverage = !Object.values(tokens).some(count) ? 'none'
      : usage.every(u => tokenKeys.every(k => u[k] !== null)) ? 'complete' : 'partial';
    return { ...r, model, thinking: model ? lastThinking ?? thinking : null, activeSeconds,
      turns: turns.length, toolCalls: calls.size, tokens, coverage: { tokens: coverage },
      costMicros: costs.length && costs.every(count) ? sum(costs, x => x) : null,
      outcome: o.outcome === 'blocked' ? r.outcome : spriteOutcome(o.rc, stopReason), changes: o.changes ?? null,
      complexity: { rating: o.rating ?? null, proxies: proxies(o.changes, r.reviewRounds, o.failedChecks ?? null, o.retries ?? null) } };
  });
}

function main() {
  const [o, names] = args('dir worktree base', ['blocked']);
  requireThat(names.length === 1 && /^[\w.-]+$/.test(names[0]) && !/^\.+$/.test(names[0]));
  requireThat(Boolean(o.worktree) === Boolean(o.base) && !o.base?.startsWith('-'));
  const prefix = join(o.dir ?? join(sep, 'tmp', 'sprites'), names[0]);
  const text = readFileSync(`${prefix}.jsonl`, 'utf8');
  let rc;
  try { rc = readFileSync(`${prefix}.rc`, 'utf8').trim(); }
  catch (e) { if (e.code === 'ENOENT') return 3; throw e; }
  requireThat(/^-?\d+$/.test(rc) && Number.isSafeInteger(Number(rc)));
  let retries = null, changes = null;
  try {
    const files = readdirSync(prefix, { withFileTypes: true }).filter(e => e.isFile()).length;
    retries = files ? files - 1 : null;
  }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (o.base) {
    const gitOptions = {
      cwd: o.worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...childEnv({ LC_ALL: 'C' }), GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    };
    const base = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${o.base}^{commit}`], gitOptions).trim();
    const stat = execFileSync('git', ['-c', 'core.attributesFile=/dev/null', `--attr-source=${base}`,
      'diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--text', '--shortstat', base, '--'], gitOptions);
    const counts = [/\d+(?= files? changed)/, /\d+(?= insertions?\()/, /\d+(?= deletions?\()/];
    changes = fields(changeKeys, k => Number(stat.match(counts[changeKeys.indexOf(k)])?.[0] ?? 0));
  }
  print(parseSprite(text, { ...o, name: names[0], rc: Number(rc), retries, changes }));
  return 0;
}
cli(import.meta.url, main, 'error: invalid sprite arguments, log, or worktree');
