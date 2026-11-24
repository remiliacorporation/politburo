import { runParty } from '../party/cli.ts'

export const name = 'party'
export const summary = 'party <list|show|add|remove|member|jockey> ...'

export function run(argv: string[]): number {
  return runParty(argv)
}
