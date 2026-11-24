import { workCommand } from '../work/cli.ts'

export const name = 'work'
export const summary = 'work check FILE [--json]'

export function run(argv: string[]): Promise<number> {
  return workCommand(argv)
}
