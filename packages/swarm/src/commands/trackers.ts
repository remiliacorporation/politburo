import { run as runTrackers } from '../trackers/cli.ts'

export const name = 'trackers'
export const summary = 'trackers scan <repo> [--party FILE] [--repo FILE] [--json]'

export function run(argv: string[]): Promise<number> {
  return runTrackers(argv)
}
