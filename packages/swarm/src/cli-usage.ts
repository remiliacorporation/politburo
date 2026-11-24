import { workUsage } from './work/cli.ts'

export const usage = 'usage: swarm config <show|validate> [--json] [--party FILE] [--repo FILE]\n       swarm score <leaderboard|card|history|drill> ...\n       swarm trackers scan <repo> [--party FILE] [--repo FILE] [--json]\n       swarm trackers beads queue --epic ID --store-name NAME (--dir DIR | --fixture FILE) [--bd PATH] [--json]\n       swarm skills sync --dir DIR [--party FILE] [--repo FILE] [--dry-run] [--force] [--json]\n       swarm capture <run|collect>\n       swarm mirror sync --repo owner/name [--json]\n       swarm overlap <work-id> --work FILE [--max-age-minutes N] [--json]\n       swarm rollout <add|notify|ack|stale|show> [--dir D] [--json]\n       swarm classifier report <dir> [--json]\n       swarm classifier clear <dir> <question> --why TEXT\n       swarm serve --help'

export function helpText(): string {
  return `${usage}\n${workUsage}`
}

export function printError(headline: string) {
  const safe = headline.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
  console.error(`error: ${safe}`)
}

export function misuse(message: string): number {
  printError(message)
  console.error(usage)
  return 2
}
