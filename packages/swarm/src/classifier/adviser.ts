import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type Usage = { input?: number; output?: number }

export interface Adviser {
  advise(packet: string): Promise<{ text: string; usage?: Usage }>
}

export const adviserTimeoutMs = 120_000

export function stubAdviser(fixedReply: string): Adviser {
  return { async advise() { return { text: fixedReply } } }
}

type Env = Record<string, string | undefined>
const allowedEnvKeys = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'])
type Run = (command: string, args: string[], options: {
  timeout: number
  env: Env & { PI_MODEL: string; PI_THINKING: string }
}) => Promise<{ stdout: string }>

// There is no live path. A real pi-task runner, no-tools enforcement, and usage
// parsing must be added and verified before live use.
export function piAdviser({ run, env, model, thinking }: {
  run: Run
  env: Env
  model: string
  thinking: string
}): Adviser {
  const runnerEnv: Env = {}
  for (const key of Object.keys(env)) {
    if (!allowedEnvKeys.has(key)) throw new Error('unlisted environment key')
    runnerEnv[key] = env[key]
  }
  return {
    async advise(packet) {
      try {
        const dir = await mkdtemp(join(tmpdir(), 'swarm-terra-'))
        try {
          const file = join(dir, 'task.txt')
          await writeFile(file, packet, { mode: 0o600 })
          const { stdout } = await run('pi-task', [file], {
            timeout: adviserTimeoutMs,
            env: { ...runnerEnv, PI_MODEL: model, PI_THINKING: thinking },
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
