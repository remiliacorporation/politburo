import { execFile } from 'node:child_process'

/** The parsed output boundary for a CLI. `null` means no usable exit status. */
export type CliResult = Readonly<{ code: number | null; stdout: string }>

export function execCli(command: string, args: readonly string[], options: {
  cwd?: string; env: NodeJS.ProcessEnv; input?: string
}): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = execFile(command, [...args], {
      cwd: options.cwd, env: options.env, shell: false, encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024, timeout: 30_000,
    }, (error, stdout) => {
      // Errors/stderr may contain secrets or untrusted instructions. Adapters
      // translate the exit status into data without surfacing either.
      resolve({ code: !error ? 0 : typeof error.code === 'number' ? error.code : null, stdout })
    })
    child.stdin?.on('error', () => {}) // A failed command can close stdin early.
    child.stdin?.end(options.input)
  })
}

export const isSha = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)

export function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
