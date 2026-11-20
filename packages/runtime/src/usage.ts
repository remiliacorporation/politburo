import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

/** Usage in the current five-hour window. resetAt is Unix time in milliseconds. */
export type UsageWindow = Readonly<{ usedFraction: number; resetAt: number }>

export interface UsageSource {
  read(): UsageWindow | Promise<UsageWindow>
}

export type UsageDecision = { allowed: true } | { allowed: false; resetAt: number }

export interface UsageGuard {
  check(): Promise<UsageDecision>
}

export type LocalUsageOptions = { file: string; command?: never; args?: never } | {
  file?: never
  command: string
  args?: readonly string[]
}

const runCommand = promisify(execFile)

function usageWindow(value: unknown): UsageWindow {
  if (value !== null && typeof value === 'object' && 'usedFraction' in value && 'resetAt' in value) {
    const { usedFraction, resetAt } = value
    if (typeof usedFraction === 'number' && usedFraction >= 0 && usedFraction <= 1 &&
        typeof resetAt === 'number' && Number.isSafeInteger(resetAt) && resetAt >= 0) {
      return { usedFraction, resetAt }
    }
  }
  throw new TypeError('invalid five-hour usage window')
}

/** Read local JSON on every check, from a file or the stdout of a trusted command. */
export function localUsage(options: LocalUsageOptions): UsageSource {
  const { file, command, args } = options
  const argv = args ? [...args] : []
  return {
    async read() {
      const text = file !== undefined ? await readFile(file, 'utf8') : await commandOutput(command, argv)
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        throw new TypeError('invalid usage JSON')
      }
      return usageWindow(value)
    },
  }
}

async function commandOutput(command: string, args: string[]) {
  try {
    const { stdout } = await runCommand(command, args, {
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
    })
    return stdout
  } catch {
    // Do not expose arguments or command output in errors.
    throw new Error('usage command failed')
  }
}

export function usageGuard(source: UsageSource, { now = Date.now }: { now?: () => number } = {}): UsageGuard {
  return {
    async check() {
      const { usedFraction, resetAt } = usageWindow(await source.read())
      if (usedFraction >= 0.95 && now() < resetAt) return { allowed: false, resetAt }
      return { allowed: true }
    },
  }
}
