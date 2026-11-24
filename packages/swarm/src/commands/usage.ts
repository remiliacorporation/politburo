import { run as runUsage } from '../usage/cli.ts'

export const name = 'usage'
export const summary = 'usage <check|wake>'

export function run(argv: string[]): Promise<number> {
  return runUsage(argv)
}
