import { runSetup } from '../sprite/cli.ts'

export const name = 'setup'
export const summary = 'setup build [--out FILE]'
export const usage: string[] = []

export function run(argv: string[]): number {
  return runSetup(argv)
}
