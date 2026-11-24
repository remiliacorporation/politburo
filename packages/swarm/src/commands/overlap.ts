import { runMirrorCommand } from '../mirror/command.ts'

export const name = 'overlap'
export const summary = 'overlap <work-id> --work FILE [--max-age-minutes N] [--json]'
export const usageOrder = 80
export const usage = ['swarm overlap <work-id> --work FILE [--max-age-minutes N] [--json]']

export function run(argv: string[]): Promise<number> {
  return runMirrorCommand(['overlap', ...argv])
}
