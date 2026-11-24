import { rolloutMain } from '../rollout/rollout-cli.ts'

export const name = 'rollout'
export const summary = 'rollout <add|notify|ack|stale|show> [--dir D] [--json]'

export function run(argv: string[]): number {
  return rolloutMain(argv)
}
