import { runParty } from '../party/cli.ts'

export const name = 'party'
export const summary = 'party <list|show|add|remove|member|jockey> ...'
export const usageOrder = 20
export const usage = [
  'swarm party <list|show|add|remove|member|jockey> ...',
  'registry file: --registry FILE or SWARM_REGISTRY',
]

export function run(argv: string[]): number {
  return runParty(argv)
}
