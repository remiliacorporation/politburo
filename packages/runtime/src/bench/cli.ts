import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { board, BoardError } from '@vercel/board'
import { isBenchRun } from './record.ts'
import { formatReport, report } from './report.ts'
import { benchStore, registerBenchSchema } from './store.ts'

export async function benchCli([command, ...args]: string[], connect = () => board(), print = console.log, error = console.error) {
  if (command === 'ingest' ? !args.length || args.some((arg) => arg.startsWith('--'))
    : command !== 'report' || args.some((arg) => arg !== '--ids' && arg !== '--json')) {
    error('usage: bench ingest <file.jsonl>... | report [--json] [--ids]')
    return 2
  }
  let problem = 'could not open benchmark board'
  try {
    const team = connect()
    const store = benchStore({ board: team, author: (await team.me()).actor })
    if (command === 'report') {
      problem = 'could not read benchmark records'
      const data = report(await store.read())
      const text = args.includes('--json') ? JSON.stringify(data) : formatReport(data)
      if (text) print(text)
      return 0
    }
    problem = 'could not set up benchmark schema'
    await team.schema('bench-run@1').catch(async (cause: unknown) => {
      if (!(cause instanceof BoardError) || cause.code !== 'schema_not_found') throw cause
      await registerBenchSchema(team)
    })
    for (const [index, file] of args.entries()) {
      const input = createReadStream(file)
      const lines = createInterface({ input, crlfDelay: Infinity })
      let lineNumber = 0
      const reading = `could not read input ${index + 1}`
      problem = reading
      try {
        for await (const line of lines) {
          lineNumber++
          if (!line.trim()) continue
          const location = `input ${index + 1}, line ${lineNumber}`
          problem = `invalid benchmark record in ${location}`
          const run: unknown = JSON.parse(line)
          if (!isBenchRun(run)) throw new TypeError()
          problem = `could not store benchmark record from ${location}`
          await store.record(run)
          problem = reading
        }
      } finally {
        input.destroy()
      }
    }
    return 0
  } catch (cause) {
    error(`error: ${problem}`)
    return cause instanceof BoardError && cause.code === 'no_board' ? 2 : 1
  }
}

if (import.meta.main) process.exitCode = await benchCli(process.argv.slice(2))
