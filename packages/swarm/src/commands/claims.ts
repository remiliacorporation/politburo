import { run as runClaims } from '../claims/cli.ts'

export const name = 'claims'
export const summary = 'claims'

export function run(argv: string[]): Promise<number> {
  return runClaims(argv)
}
