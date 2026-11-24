import { runScore } from '../scoring/cli.ts'

export const name = 'score'
export const summary = 'score <leaderboard|card|history|drill> ...'

export function run(argv: string[]): number {
  return runScore(argv)
}
