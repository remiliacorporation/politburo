import { allocMain } from '../rollout/cli.ts'

export const name = 'alloc'
export const summary = 'alloc serial [--dir DIR] [--json]\nalloc name <spawner|secretary|species|item> [JOB] --in-use NAME [--json] [--party FILE] [--repo FILE]'
export const usageOrder = 95
export const usage = [
  'swarm alloc serial [--dir DIR] [--json]',
  'swarm alloc name <spawner|secretary|species|item> [JOB]',
  '  --in-use NAME [--in-use NAME ...] [--json] [--party FILE] [--repo FILE]',
]

export function run(argv: string[]): number {
  return allocMain(argv)
}
