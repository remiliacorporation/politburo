import { runTrackers as runBeads } from '../trackers/beads/cli.ts'
import { run as runScan } from '../trackers/cli.ts'

export const name = 'trackers'
export const summary = 'trackers scan <repo> [--party FILE] [--repo FILE] [--json]'
export const usageOrder = 40
export const usage = [
  'swarm trackers scan <repo> [--party FILE] [--repo FILE] [--json]',
  'swarm trackers beads queue --epic ID --store-name NAME (--dir DIR | --fixture FILE) [--bd PATH] [--json]',
]

export function run(argv: string[]): Promise<number> {
  return argv[0] === 'scan' ? runScan(argv) : runBeads(argv)
}
