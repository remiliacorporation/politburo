import { outcomeCommand } from '../outcomes/cli.ts'

export const name = 'outcome'
export const summary = 'outcome <submit|review|complete> --task ID [--json]'

export function run(argv: string[]): Promise<number> {
  return outcomeCommand(argv, console)
}
