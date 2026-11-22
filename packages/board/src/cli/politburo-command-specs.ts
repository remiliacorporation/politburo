import type { CliArgument, CliCommand, groups, option } from './commands.ts'

type GroupedCommand = CliCommand & { readonly group: (typeof groups)[number] }
type Option = typeof option
type TaskArgument = (description?: string) => CliArgument

export const controlOptions = {
  reason: { type: 'string', value: 'reason', description: 'why, recorded in the board log (required)' },
} as const

export const inviteOptions = {
  out: { type: 'string', value: 'file', description: 'required: save the secret to a new private file' },
  'expires-in': { type: 'string', value: 'seconds', description: 'when the invite expires, in seconds (1 to 604800; default: 86400)' },
} as const

export const teamOptions = {
  host: { type: 'string', value: 'bind-ip', description: 'the IP to listen on (default: 127.0.0.1); requires --team-tokens' },
  'team-tokens': { type: 'string', value: 'file', description: 'serve only the API, using team tokens from a JSON file; cannot be used with --tailscale' },
} as const

export const swarmOptions = {
  swarm: { type: 'boolean', description: 'enable agent ops and task attention for the local owner; cannot be used with --team-tokens' },
  responder: { type: 'string', multiple: true, value: 'principal', description: 'let this principal answer task attention where they can read and post' },
  // Agent registry.
  'agent-ops': { type: 'boolean', description: 'enable the fork-only agent registry and intents' },
  role: { type: 'string', value: 'role', description: 'required: coordinator, issues, controller, implementation-worker, reviewer, qa-owner, qa-runner, or user-watcher' },
  harness: { type: 'string', value: 'harness', description: 'required: the harness running this agent' },
  parent: { type: 'string', value: 'id', description: 'the ID of a registered parent in the same channel (default: no parent)' },
  generation: { type: 'string', value: 'N', description: 'required: the current generation, as agents list shows it' },
  ttl: { type: 'string', value: 'duration', description: 'required: how long to keep the intent, e.g. 20s (max 60s, or 30s for a run probe)' },
  task: { type: 'string', value: 'id', description: 'with status: probe the live claim on this task' },
  epoch: { type: 'string', value: 'N', description: 'with --task: the epoch of its live claim' },
} as const

export const priorityOptions = {
  priority: { type: 'string', value: 'level', description: 'lowest, low, normal (default), high, or urgent' },
} as const

export const authorityOptions = {
  binding: { type: 'string', value: 'JSON', description: 'claim metadata: controller, owner, provider, model, session, branch, worktree, and baseCommit' },
  supersedes: { type: 'string', value: 'id', description: 'the current handoff ID when replacing one' },
} as const

export const attentionOptions = {
  commit: { type: 'string', value: 'sha', description: 'the full lowercase SHA on the request' },
} as const

export const admissionCommands = (option: Option): readonly GroupedCommand[] => [
  {
    group: 'you',
    name: 'join',
    description: 'redeem an invite and save a credential for that board URL',
    arguments: [
      { name: 'url', required: true, description: 'the board URL: HTTPS, or HTTP on loopback' },
      { name: 'invite', required: true, description: 'the secret, or - to read it from stdin' },
    ],
    options: [],
    examples: [{ name: 'join without putting the secret in the command line', value: 'join https://board.example.com/api/board - < invite.txt' }],
  },
  {
    group: 'the board',
    name: 'invite',
    description: 'give someone access to the board with a one-time invite',
    arguments: [],
    options: [],
    examples: [],
    subcommands: [
      {
        name: 'create',
        description: 'create an invite and save its secret to a new private file',
        arguments: [{ name: 'name', required: true, description: 'starts with a letter; up to 32 letters, digits, and hyphens' }],
        options: [option('out'), option('expires-in'), option('can', 'pattern=permissions, repeated: read, post, react, label, or sync')],
        examples: [{ name: 'invite a member', value: 'invite create sam --out invite.txt' }],
      },
      {
        name: 'list',
        description: 'list invites and their states, without secrets',
        arguments: [],
        options: [],
        examples: [],
      },
      {
        name: 'revoke',
        description: 'revoke a pending invite',
        arguments: [{ name: 'id', required: true, description: 'the ID from invite list' }],
        options: [],
        examples: [],
      },
    ],
  },
  {
    group: 'the board',
    name: 'status',
    description: 'see if the board is admitting work',
    arguments: [],
    options: [],
    examples: [{ name: 'check the board', value: 'status' }],
  },
  {
    group: 'the board',
    name: 'pause',
    description: 'stop task claims and scheduled sends on the board',
    brief: '--reason <reason>',
    arguments: [],
    options: [option('reason')],
    examples: [{ name: 'pause work during maintenance', value: 'pause --reason "queue maintenance"' }],
  },
  {
    group: 'the board',
    name: 'resume',
    description: 'allow new task claims and future scheduled sends',
    brief: '--reason <reason>',
    arguments: [],
    options: [option('reason')],
    examples: [{ name: 'resume work after maintenance', value: 'resume --reason "maintenance complete"' }],
  },
]

export const inboxCommands = (option: Option): readonly CliCommand[] => [
  {
    name: 'read',
    description: 'read your 15 latest active operational messages',
    arguments: [],
    options: [],
    examples: [{ name: 'read your operational inbox', value: 'inbox read' }],
  },
  {
    name: 'ack',
    description: 'mark an operational message seen or acted',
    arguments: [
      { name: 'id', required: true, description: 'the ID inbox read shows' },
      { name: 'seen|acted', required: true },
    ],
    options: [],
    examples: [{ name: 'mark a message seen', value: 'inbox ack 812 seen' }],
  },
  {
    name: 'archive',
    description: 'hide an operational message from your inbox',
    arguments: [{ name: 'id', required: true, description: 'the ID inbox read shows' }],
    options: [],
    examples: [{ name: 'archive a message', value: 'inbox archive 812' }],
  },
  {
    name: 'raw',
    description: 'read raw platform events, including for reserved sync keys',
    arguments: [
      { name: 'key', required: true, description: 'the sync entry' },
      { name: 'channel', required: false, description: 'the board channel its events went to' },
    ],
    options: [option('limit', 'events to list')],
    examples: [{ name: 'list events for a sync entry named read', value: 'inbox raw read' }],
  },
]

export const taskPriorityCommands = (task: TaskArgument, priorityDescription: string): readonly CliCommand[] => [
  {
    name: 'show',
    description: 'show one task, including its priority',
    arguments: [task()],
    options: [],
    examples: [{ name: 'show a task', value: 'tasks show 812' }],
  },
  {
    name: 'priority',
    description: 'set a task’s priority; with your claim, only lower it',
    arguments: [task(), { name: 'level', required: true, description: priorityDescription }],
    options: [],
    examples: [{ name: 'set a task’s priority', value: 'tasks priority 812 high' }],
  },
]

export const taskAttentionCommands = (task: TaskArgument, option: Option): readonly CliCommand[] => [
  {
    name: 'ask',
    description: 'hold a task for a decision on a specific commit',
    arguments: [task()],
    options: [option('file', 'a JSON draft with kind, question, context, options, evidence, expiresAt, commit, revision, and optional replaces: - reads stdin')],
    examples: [{ name: 'ask for a decision', value: 'tasks ask 813 --file attention.json' }],
  },
  {
    name: 'attention',
    description: 'read the current attention request on a task',
    arguments: [task()],
    options: [],
    examples: [{ name: 'read the request and its options', value: 'tasks attention 813' }],
  },
  {
    name: 'answer',
    description: 'choose an option on a task attention request, as a configured responder',
    arguments: [task(), { name: 'request-id', required: true, description: 'the current attention request ID' }, { name: 'option', required: true, description: 'the option ID to choose, such as approve or retry-2' }],
    options: [option('commit')],
    examples: [{ name: 'answer an attention request', value: 'tasks answer 813 7c9a5f1e-2d84-4b6a-9e3c-5f8a1d2b6740 approve --commit 8f3a2c7e9b1d4f6a0c5e8b2d7f1a3c9e4b6d0f2a' }],
  },
]

export const taskAuthorityCommands = (task: TaskArgument, option: Option): readonly CliCommand[] => [
  {
    name: 'park',
    description: 'put a task on operator hold and end any claim: as yourself with manage in its channel',
    arguments: [task(), { name: 'reason', required: true, description: 'why, in a line' }],
    options: [],
    examples: [{ name: 'park a task', value: 'tasks park 813 "waiting for the maintenance window"' }],
  },
  {
    name: 'unpark',
    description: 'lift an operator hold without restoring the claim: as yourself with manage in its channel',
    arguments: [task(), { name: 'reason', required: true, description: 'why, in a line' }],
    options: [],
    examples: [{ name: 'unpark a task', value: 'tasks unpark 813 "maintenance window opened"' }],
  },
  {
    name: 'handoff',
    description: 'record a handoff with your claim, without reading the packet or ending the lease',
    arguments: [
      task(),
      { name: 'commit', required: true, description: 'a full lowercase commit ID' },
      { name: 'packet-path', required: true, description: 'the path to the packet relative to the repository root' },
      { name: 'sha256', required: true, description: 'the lowercase SHA-256 digest of the packet' },
    ],
    options: [option('supersedes')],
    examples: [],
  },
]

export function agentsCommand(option: Option, id: TaskArgument, task: TaskArgument): GroupedCommand {
  /** An agent registry's channel or agent ID. */
  const agentChannel: CliArgument = { name: 'channel', required: true, description: 'the exact channel, such as work/review' }
  const agentId = () => id('the agent ID, as agents list shows it')
  const intentId = () => id('the intent ID, as agents intents shows it')
  const intentVerb: CliArgument = { name: 'verb', required: true, description: 'inspect, status, pause, interrupt, resume, collect, or poke' }
  const issueOptions = [option('generation'), option('ttl'), option('task'), option('epoch'), option('idempotency-key', 'retry the same issue request without sending it twice')]

  return {
    group: 'agents',
    name: 'agents',
    description: 'the channel roster, command intents, and task run health on an opt-in board',
    arguments: [],
    options: [],
    examples: [],
    subcommands: [
      {
        name: 'list',
        description: 'list enabled and retired agents in one channel',
        arguments: [agentChannel],
        options: [],
        examples: [{ name: 'see who is registered', value: 'agents list work/review' }],
      },
      {
        name: 'register',
        description: 'register yourself or your profile, or update its registration',
        arguments: [agentChannel],
        options: [option('role'), option('harness'), option('parent'), option('generation', 'the current generation, required to change or re-enable an entry')],
        examples: [{ name: 'register a reviewer', value: 'agents register work --role reviewer --harness codex --as qa' }],
      },
      {
        name: 'heartbeat',
        description: 'record a heartbeat for your enabled agent',
        arguments: [agentId()],
        options: [option('generation')],
        examples: [],
      },
      {
        name: 'retire',
        description: 'disable your registered agent',
        arguments: [agentId()],
        options: [option('generation')],
        examples: [],
      },
      {
        name: 'issue-intent',
        description: 'send an intent to one agent',
        arguments: [agentId(), intentVerb],
        options: issueOptions,
        examples: [{ name: 'ask an agent for its status', value: 'agents issue-intent "$agent" status --generation 1 --ttl 20s' }],
      },
      {
        name: 'issue-role-intent',
        description: 'send an intent to the enabled agents of one role in a channel',
        arguments: [agentChannel, { name: 'role', required: true, description: 'a role, as agents list shows it' }, intentVerb],
        options: issueOptions,
        examples: [{ name: 'poke the reviewers', value: 'agents issue-role-intent work reviewer poke --generation 1 --ttl 20s' }],
      },
      {
        name: 'intents',
        description: 'list pending intents for an agent, oldest first',
        arguments: [agentId()],
        options: [option('after', 'continue from the next cursor agents intents printed', 'cursor')],
        examples: [],
      },
      {
        name: 'take-intent',
        description: 'take one pending intent addressed to your agent',
        arguments: [intentId()],
        options: [option('generation')],
        examples: [],
      },
      {
        name: 'report-intent',
        description: 'report an outcome for an intent you took',
        arguments: [intentId(), { name: 'outcome', required: true, description: 'ok or failed, or for a run probe: running, not_running, or unknown' }],
        options: [option('generation')],
        examples: [],
      },
      {
        name: 'health',
        description: 'show whether a recent probe confirms the task is working',
        arguments: [task()],
        options: [],
        examples: [{ name: 'check task 812', value: 'agents health 812' }],
      },
    ],
  }
}
