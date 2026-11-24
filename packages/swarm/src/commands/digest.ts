import { run as runDigest } from '../digest/cli.ts'

export const name = 'digest'
export const summary = 'digest'

export function run(argv: string[]): Promise<number> {
  return runDigest(argv)
}
