import type { AgentView } from '../api/routes.ts'
import { AgentRole, IntentOutcome, IntentVerb, type AgentIntent } from '../contract/schemas.ts'
import { globalOptions } from './commands.ts'
import { commandLine, type Recovery } from './failure.ts'
import { lineText } from './format.ts'
import { cli, client, current, flags, named, onSameBoard, ordered, out, ref, rerunWithout, seconds, specOf, taskId, result, usage } from './main.ts'

function formatAgent(agent: AgentView): string {
  const { id, channel, role, harness, binding, generation, parent, status, heartbeatAt } = agent
  return [
    `${lineText(id)}  ${role}`,
    `  channel     ${lineText(channel)}`,
    `  principal   ${lineText(binding.principal)}`,
    `  profile     ${binding.profile === null ? 'none' : lineText(binding.profile)}`,
    `  harness     ${lineText(harness)}`,
    `  parent      ${parent === null ? 'none' : lineText(parent)}`,
    `  generation  ${generation}`,
    `  status      ${status}`,
    `  heartbeat   ${heartbeatAt === null ? 'none' : lineText(heartbeatAt)}`,
  ].join('\n')
}

function formatIntent(intent: AgentIntent): string {
  const { id, agent, generation, verb, run, state, expiresAt, report } = intent
  return [
    `${lineText(id)}  ${verb} ${state}`,
    `  agent       ${lineText(agent)}`,
    `  generation  ${generation}`,
    `  expires     ${lineText(expiresAt)}`,
    ...(run ? [`  task        ${lineText(run.task)}`, `  epoch       ${run.epoch}`] : []),
    ...(report ? [`  outcome     ${report.outcome.replaceAll('_', ' ')}`] : []),
  ].join('\n')
}

export async function agents(args: string[]): Promise<number> {
  const [verb, ...given] = args
  if (verb === undefined) throw usage('Missing the agent command.', { reason: 'missing_arguments' })
  const sub = specOf('agents')?.subcommands?.find(({ name }) => name === verb)
  if (!sub) throw usage(`Unknown agent command ${verb}.`, { reason: 'unknown_command' })
  const next = [{ instruction: 'See how to use it', argv: [...cli(), 'agents', verb, '--help'] }]
  const missing = sub.arguments.find((arg, i) => arg.required && !given[i])
  if (missing) throw usage(`Missing <${missing.name}>.`, { reason: 'missing_arguments', next })
  if (given.length > sub.arguments.length) throw usage(`Too many arguments for agents ${verb}.`, { next })
  const target = given[0]!
  const seen = new Set<string>()
  for (const { name } of ordered) {
    if (globalOptions.some((option) => option.name === name)) continue
    if (!sub.options.some((option) => option.name === name))
      throw usage(`Unknown option --${name} for ${named()} agents ${verb}.`, { reason: 'unknown_option', next })
    if (seen.has(name)) throw usage(`Pass --${name} once.`, { next })
    seen.add(name)
  }
  if (verb === 'list') {
    const { agents } = await client().agents.list(target)
    if (flags.json) result({ agents })
    else out(agents.length ? agents.map(formatAgent).join('\n\n') : 'no agents registered')
    return 0
  }

  if (verb === 'intents') {
    const page = await client().agents.intents(target, flags.after === undefined ? undefined : { after: flags.after })
    if (flags.json) result(page)
    else {
      out(page.intents.length ? page.intents.map(formatIntent).join('\n\n') : 'no pending intents on this page')
      if (page.next !== null) out(`next  ${commandLine(rerunWithout(['--after'], `--after=${page.next}`))}`)
    }
    return 0
  }
  if (verb === 'health') {
    const id = taskId(target)
    const health = await client().agents.health(id)
    if (flags.json) result({ health })
    else out(`${lineText(id)}  ${health.state === 'working' ? `working until ${lineText(health.validUntil)}` : 'stale'}`)
    return 0
  }

  function positive(flag: 'generation' | 'epoch'): number {
    const value = flags[flag]
    if (value === undefined) throw usage(`Missing --${flag}.`, { reason: 'missing_arguments', next })
    const number = Number(value)
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) throw usage(`--${flag} takes a positive integer.`, { next })
    return number
  }

  if (verb === 'issue-intent' || verb === 'issue-role-intent') {
    const byRole = verb === 'issue-role-intent'
    const command = IntentVerb.safeParse(given[byRole ? 2 : 1])
    if (!command.success) throw usage('Pass one of the intent verbs shown in help.', { next })
    if ((flags.task === undefined) !== (flags.epoch === undefined)) throw usage('Pass --task and --epoch together.', { next })
    const run = flags.task === undefined ? undefined : { task: taskId(flags.task), epoch: positive('epoch') }
    if (run && command.data !== 'status') throw usage('Only status takes --task and --epoch.', { next })
    const generation = positive('generation')
    const max = run ? 30 : 60
    if (flags.ttl === undefined) throw usage('Missing --ttl.', { reason: 'missing_arguments', next })
    const ttlSeconds = seconds('ttl')!
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > max)
      throw usage(`--ttl takes a whole number of seconds from 1s to ${max}s.`, { next })
    const input = {
      verb: command.data,
      ...(run ? { run } : {}),
      generation,
      ttlSeconds,
      requestId: flags['idempotency-key'] ?? crypto.randomUUID(),
    }
    const role = byRole ? AgentRole.safeParse(given[1]) : undefined
    if (role && !role.success) throw usage('Pass a role as agents list shows it.', { next })
    const issued = role
      ? await client().agents.issueRoleIntent({ channel: target, role: role.data, ...input })
      : await client().agents.issueIntent(target, input)
    if (flags.json) result(issued)
    else out(issued.intents.map(formatIntent).join('\n\n'))
    return 0
  }
  if (verb === 'take-intent' || verb === 'report-intent') {
    const generation = positive('generation')
    let intent: AgentIntent
    if (verb === 'report-intent') {
      const outcome = IntentOutcome.safeParse(given[1])
      if (!outcome.success) throw usage('Pass one of the outcomes shown in help.', { next })
      intent = await client().agents.reportIntent(target, generation, outcome.data)
    } else intent = await client().agents.takeIntent(target, generation)
    if (flags.json) result({ intent })
    else out(formatIntent(intent))
    return 0
  }

  let agent: AgentView
  if (verb === 'register') {
    const { harness, parent } = flags
    if (!flags.role) throw usage('Missing --role.', { reason: 'missing_arguments', next })
    if (!harness) throw usage('Missing --harness.', { reason: 'missing_arguments', next })
    const role = AgentRole.safeParse(flags.role)
    if (!role.success) throw usage('--role takes one of the roles shown in help.', { next })
    agent = await client().agents.register({
      channel: target,
      role: role.data,
      harness,
      ...(parent !== undefined ? { parent } : {}),
      ...(flags.generation !== undefined ? { ifGeneration: positive('generation') } : {}),
    })
  } else {
    const generation = positive('generation')
    agent = verb === 'heartbeat' ? await client().agents.heartbeat(target, generation) : await client().agents.retire(target, generation)
  }
  if (flags.json) result({ agent })
  else out(formatAgent(agent))
  return 0
}

/** The agent commands that write to the registry. */
export const AGENT_WRITES = new Set(['register', 'heartbeat', 'retire', 'issue-intent', 'issue-role-intent', 'take-intent', 'report-intent'])

export function doingAgents(a: string | undefined, b: string | undefined): string {
  if (a === 'list' || a === 'register') return `${a === 'list' ? 'list agents' : 'register an agent'} in ${b ?? 'a channel'}`
  if (a === 'heartbeat') return `record a heartbeat for agent ${b}`
  if (a === 'retire') return `retire agent ${b}`
  if (a === 'issue-intent') return `issue an intent to agent ${b}`
  if (a === 'issue-role-intent') return `issue a role intent in ${b}`
  if (a === 'intents') return `list intents for agent ${b}`
  if (a === 'take-intent' || a === 'report-intent') return `${a === 'take-intent' ? 'take' : 'report'} intent ${b}`
  if (a === 'health') return `check run health for task ${ref(b)}`
  return 'work with agents'
}

export function missingAgent(a: string, b: string): string | undefined {
  if (a === 'heartbeat' || a === 'retire' || a === 'intents') return `agent ${b}`
  if (a === 'take-intent' || a === 'report-intent') return `intent ${b}`
  if (a === 'health') return `task ${ref(b)}`
}

export function agentConflictRecovery(): Recovery[] {
  const channel = current.args[0] === 'register' || current.args[0] === 'issue-role-intent' ? current.args[1] : undefined
  return [
    channel === undefined
      ? { instruction: 'Check the current generation with agents list in its channel' }
      : { instruction: 'Check the current generation', argv: [...cli(), 'agents', 'list', channel, ...onSameBoard()] },
  ]
}
