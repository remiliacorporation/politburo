import { BoardError, type Board } from '@vercel/board'
import { benchRunSchema, isBenchRun, type BenchRun } from './record.ts'

/** Run once with permission to register schemas. */
export async function registerBenchSchema(board: Pick<Board, 'createSchema'>) {
  await board.createSchema({
    name: 'bench-run', version: 1, description: 'Benchmark run counts, identifiers, and times.', schema: benchRunSchema,
  })
}

/**
 * One channel is one read across tasks (paged as needed). Storing blocks on
 * task threads would require enumerating threads and put measurements in the
 * conversation people read.
 */
export function benchStore({ board, channel = 'bench', author }: {
  board: Pick<Board, 'me' | 'post' | 'posted' | 'channel'>
  channel?: string
  author: string
}) {
  return {
    async record(run: BenchRun) {
      if ((await board.me()).actor !== author) throw new Error('benchmark writer does not match the configured author')
      // Validate what the caller passed too: serialization turns Infinity and NaN into null.
      if (!isBenchRun(run)) throw new TypeError('invalid benchmark record')
      const json = JSON.stringify(run, null, 2)
      const parsed: unknown = JSON.parse(json)
      if (!isBenchRun(parsed)) throw new TypeError('invalid benchmark record')
      const id = `bench-run:${parsed.runId}`
      // Fence the exact JSON we validated, without invoking serialization again.
      const text = `\`\`\`json#bench-run@1\n${json}\n\`\`\``
      if (text.length > 9_000) throw new TypeError('benchmark block exceeds 9000 characters')
      const message = await board.post(channel, { id, text, noSync: true }).catch((error: unknown) => {
        // A changed replay doesn't replace the first write.
        if (!(error instanceof BoardError) || error.code !== 'duplicate_id') throw error
        return board.posted(id)
      })
      if (message.by.actor !== author) throw new Error('benchmark writer does not match the configured author')
      if (message.channel !== channel || message.deleted || message.re !== null || !message.blocks.some(({ schema, version, data }) =>
        schema === 'bench-run' && version === 1 && isBenchRun(data) && data.runId === parsed.runId)) {
        throw new Error('board did not return a matching live benchmark record')
      }
    },
    async read(): Promise<BenchRun[]> {
      const runs = new Map<string, BenchRun>()
      // With no after cursor the handle reads the newest page. Start at zero.
      let after = '0'
      for (;;) {
        const { messages, cursor } = await board.channel(channel).messages({ after, limit: 100 })
        for (const message of messages) {
          if (message.by.actor !== author || message.deleted || message.re !== null) continue
          for (const { schema, version, data } of message.blocks) {
            // Pages are oldest first. The first valid write for each ID wins.
            if (schema === 'bench-run' && version === 1 && isBenchRun(data) && !runs.has(data.runId)) runs.set(data.runId, data)
          }
        }
        if (cursor === after) return [...runs.values()]
        after = cursor
      }
    },
  }
}
