import { runClassifierCli } from '../classifier/cli.ts'

export const name = 'classifier'
export const summary = 'classifier report <dir> [--json]\nclassifier clear <dir> <question> --why TEXT'
export const usageOrder = 100
export const usage = [
  'swarm classifier report <dir> [--json]',
  'swarm classifier clear <dir> <question> --why TEXT',
]

export function run(argv: string[]): number {
  return runClassifierCli(argv)
}
