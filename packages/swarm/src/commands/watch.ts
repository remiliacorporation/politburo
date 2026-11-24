import { run as runWatch } from '../watch/cli.ts'

export const name = 'watch'
export const summary = 'watch'
export const usage: string[] = []

export function run(argv: string[]): Promise<number> {
  return runWatch(argv)
}
