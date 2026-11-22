import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { loadConfig } from '../config/load.ts'

export type Usage = { input?: number; output?: number }

export interface Adviser {
  advise(packet: string): Promise<{ text: string; usage?: Usage }>
}

export const adviserTimeoutMs = 120_000

export function stubAdviser(fixedReply: string): Adviser {
  return { async advise() { return { text: fixedReply } } }
}

type Run = (command: string, args: string[], options: {
  timeout: number
  env: { PATH: string | undefined; HOME: string | undefined; PI_MODEL: string; PI_THINKING: string }
}) => Promise<{ stdout: string }>

const exec: Run = promisify(execFile)

// pi-task invocation, no-tools enforcement beyond the prompt, and usage parsing
// are unverified until a real run. Use a fake run in tests.
export function piAdviser({ run = exec, model = loadConfig().tiers.models.adviser, thinking }: {
  run?: Run
  model?: string
  thinking: string
}): Adviser {
  return {
    async advise(packet) {
      try {
        const dir = await mkdtemp(join(tmpdir(), 'swarm-terra-'))
        try {
          const file = join(dir, 'task.txt')
          await writeFile(file, packet, { mode: 0o600 })
          const { stdout } = await run('pi-task', [file], {
            timeout: adviserTimeoutMs,
            env: { PATH: process.env.PATH, HOME: process.env.HOME, PI_MODEL: model, PI_THINKING: thinking },
          })
          return { text: stdout }
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      } catch {
        throw new Error('pi adviser unavailable')
      }
    },
  }
}
