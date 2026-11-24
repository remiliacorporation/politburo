import { run as runCheck } from '../checks/cli.ts'

export const name = 'check'
export const summary = 'check'
export const usage: string[] = []

export function run(argv: string[]): Promise<number> {
  return runCheck(argv)
}
