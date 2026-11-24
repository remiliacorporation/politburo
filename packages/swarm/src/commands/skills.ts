import { skillsMain } from '../skills/cli.ts'

export const name = 'skills'
export const summary = 'skills sync --dir DIR [--party FILE] [--repo FILE] [--dry-run] [--force] [--json]'
export const usageOrder = 50
export const usage = ['swarm skills sync --dir DIR [--party FILE] [--repo FILE] [--dry-run] [--force] [--json]']

export function run(argv: string[]): number {
  return skillsMain(argv)
}
