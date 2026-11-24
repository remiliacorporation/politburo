import { reviewCommand } from '../review/cli.ts'

export const name = 'review'
export const summary = 'review record <task-id> <pass|blocked> --head <sha>'
export const usageOrder = 25
export const usage = ['swarm review record <task-id> <pass|blocked> --head <sha> [--finding TEXT]... [--follow-up]']

export function run(argv: string[]): Promise<number> {
  return reviewCommand(argv)
}
