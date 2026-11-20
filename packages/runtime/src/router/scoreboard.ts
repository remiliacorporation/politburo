import { block, type Board } from '@vercel/board'
import { failures, isAmount, isName, modelKey, type AttemptFailure, type Model } from './contract.ts'

const schema = 'runtime-attempt@1'
const outcomes = ['verified', ...failures] as const

export type AttemptSample = Model & Readonly<{
  attemptId: string
  outcome: AttemptFailure | 'verified'
  costMicros: number | null
  latencyMs: number
}>

export type ModelScore = Model & Readonly<{
  attempts: number
  successRate: number
  meanCostMicros: number | null
  meanLatencyMs: number
}>

export interface ModelScoreboard {
  read(): Promise<readonly ModelScore[]>
  record(sample: AttemptSample): Promise<void>
}

/** Run once with a handle allowed to register schemas. */
export async function registerScoreboardSchema(board: Pick<Board, 'createSchema'>) {
  const amount = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
  const name = { type: 'string', minLength: 1, maxLength: 128 }
  const properties = {
    attemptId: name, provider: name, model: name, outcome: { enum: [...outcomes] },
    costMicros: { anyOf: [amount, { type: 'null' }] }, latencyMs: amount,
  }
  await board.createSchema({
    name: 'runtime-attempt', version: 1, description: 'Outcome, token cost, and latency of a routed attempt.',
    schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
  })
}

function isSample(data: unknown): data is AttemptSample {
  if (!data || typeof data !== 'object') return false
  const sample = data as Partial<AttemptSample>
  return isName(sample.attemptId) && isName(sample.provider) && isName(sample.model) &&
    sample.outcome !== undefined && outcomes.includes(sample.outcome) &&
    (sample.costMicros === null || isAmount(sample.costMicros)) && isAmount(sample.latencyMs)
}

/** One dedicated channel and trusted board actor; no additional storage or label policy. */
export function boardScoreboard({ board, channel, author, window = 100 }: {
  board: Pick<Board, 'post' | 'channel'>
  channel: string
  author: string
  window?: number
}): ModelScoreboard {
  if (!Number.isInteger(window) || window < 1 || window > 100) throw new RangeError('invalid scoreboard window')
  return {
    async record({ attemptId, provider, model, outcome, costMicros, latencyMs }) {
      const sample = { attemptId, provider, model, outcome, costMicros, latencyMs }
      if (!isSample(sample)) throw new TypeError('invalid attempt sample')
      const message = await board.post(channel, {
        id: `runtime-attempt:${attemptId}`, text: block(schema, sample), noSync: true,
      })
      if (message.by.actor !== author) throw new Error('scoreboard writer does not match the configured author')
    },
    async read() {
      const { messages } = await board.channel(channel).messages({ limit: window })
      const seen = new Set<string>()
      const groups = new Map<string, { model: Model; attempts: number; successes: number; costs: number; cost: number; latency: number }>()
      for (const message of [...messages].reverse()) {
        if (message.by.actor !== author || message.deleted || message.re !== null) continue
        const data = message.blocks.find((entry) => entry.schema === 'runtime-attempt' && entry.version === 1)?.data
        if (!isSample(data) || seen.has(data.attemptId)) continue
        seen.add(data.attemptId)
        const key = modelKey(data)
        const row = groups.get(key) ?? {
          model: { provider: data.provider, model: data.model }, attempts: 0, successes: 0, costs: 0, cost: 0, latency: 0,
        }
        row.attempts++
        row.successes += Number(data.outcome === 'verified')
        row.latency += data.latencyMs
        if (data.costMicros !== null) {
          row.costs++
          row.cost += data.costMicros
        }
        groups.set(key, row)
      }
      return [...groups.values()].map((row) => ({
        ...row.model, attempts: row.attempts, successRate: row.successes / row.attempts,
        meanCostMicros: row.costs ? row.cost / row.costs : null, meanLatencyMs: row.latency / row.attempts,
      }))
    },
  }
}
