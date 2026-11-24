import { workCommand, workUsageLines } from '../work/cli.ts'

export const name = 'work'
export const summary = 'work check FILE [--json]'
export const usageOrder = 120
export const catalog = false
export const usage = workUsageLines

export function run(argv: string[]): Promise<number> {
  return workCommand(argv)
}
