import { readFileSync } from 'node:fs';
import { cli, iso, jsonl, print } from '../record.mjs';

const events = 'session model_change thinking_level_change agent_start agent_end agent_settled turn_start turn_end message_start message_update message_end tool_execution_start tool_execution_update tool_execution_end'.split(' ');
const pick = (o, keys, accepts) => Object.fromEntries(keys.split(' ').filter(k => accepts(o[k])).map(k => [k, o[k]]));
const labeler = prefix => {
  const labels = new Map();
  return value => {
    if (typeof value !== 'string') return undefined;
    if (!labels.has(value)) labels.set(value, `${prefix}${labels.size + 1}`);
    return labels.get(value);
  };
};
const usage = u => u && ({
  ...pick(u, 'input output cacheRead cacheWrite reasoning totalTokens', Number.isFinite),
  cost: u.cost && pick(u.cost, 'input output cacheRead cacheWrite total', Number.isFinite),
});

export function sanitize(text) {
  const response = labeler('r'), call = labeler('c'), session = labeler('s');
  const provider = labeler('p'), model = labeler('m'), tool = labeler('tool');
  const safe = o => ({
    ...pick(o, 'role', x => ['assistant', 'user', 'toolResult'].includes(x)),
    ...pick(o, 'stopReason', x => ['stop', 'length', 'toolUse', 'error', 'aborted'].includes(x)),
    ...pick(o, 'thinkingLevel', x => ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(x)),
    ...pick(o, 'isError willRetry aborted', x => typeof x === 'boolean'),
    ...pick(o, 'timestamp durationMs', Number.isFinite),
    ...(typeof o.timestamp === 'string' && Number.isFinite(Date.parse(o.timestamp)) ? { timestamp: iso(Date.parse(o.timestamp)) } : {}),
    provider: provider(o.provider), model: model(o.model), toolName: tool(o.toolName),
    responseId: response(o.responseId), toolCallId: call(o.toolCallId), usage: usage(o.usage),
  });
  return jsonl(text).filter(e => events.includes(e.type)).map(e => ({
    type: e.type, ...safe(e), id: e.type === 'session' ? session(e.id) : undefined,
    message: e.message && safe(e.message), messages: e.messages?.map(safe), toolResults: e.toolResults?.map(safe),
  }));
}

cli(import.meta.url, () => print(sanitize(readFileSync(process.argv[2], 'utf8'))), 'error: expected a readable log');
