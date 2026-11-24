import { tagsCommand, tagsUsageLines } from '../tags/cli.ts'

export const name = 'tags'
export const summary = 'tags check [--registry FILE] [--json]'
export const usageOrder = 45
export const usage = tagsUsageLines

export function run(argv: string[]): Promise<number> {
  return tagsCommand(argv)
}
