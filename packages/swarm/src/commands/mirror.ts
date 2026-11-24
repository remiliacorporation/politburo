import { runMirrorCommand } from '../mirror/command.ts'

export const name = 'mirror'
export const summary = 'mirror sync --repo owner/name [--json]'
export const usageOrder = 70
export const usage = ['swarm mirror sync --repo owner/name [--json]']

export function run(argv: string[]): Promise<number> {
  return runMirrorCommand(['mirror', ...argv])
}
