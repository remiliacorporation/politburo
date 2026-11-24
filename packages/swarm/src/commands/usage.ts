import { run as runUsage } from '../usage/cli.ts'

export const name = 'usage'
export const summary = 'usage <check|wake>'
export const usage: string[] = []

export function run(argv: string[]): Promise<number> {
  return runUsage(argv)
}
