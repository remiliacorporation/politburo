import { runTrackers as runBeads } from '../trackers/beads/cli.ts'
import { run as runScan } from '../trackers/cli.ts'

export const name = 'trackers'
export const summary = 'trackers scan <repo> [--party FILE] [--repo FILE] [--json]'

export function run(argv: string[]): Promise<number> {
  return argv[0] === 'scan' ? runScan(argv) : runBeads(argv)
}
