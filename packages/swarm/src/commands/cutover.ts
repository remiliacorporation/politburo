import { run as runCutover } from '../cutover/cli.ts'

export const name = 'cutover'
export const summary = 'cutover <plan|apply|rollback|soak|acks> <tag> [flags]'

export function run(argv: string[]): Promise<number> {
  return runCutover(argv)
}
