import { isPrincipalId } from '../server/auth.ts'
import type { LocalOptions } from '../server/local.ts'
import { Failed } from './main.ts'

export function swarmOptions(
  options: { swarm?: true; teamTokens?: string; agentOps?: true; responders?: readonly string[] },
  principal: string,
): LocalOptions {
  if (options.swarm && options.teamTokens !== undefined) throw new Failed({
    class: 'usage',
    reason: 'invalid_arguments',
    message: "--swarm can't be used with --team-tokens.",
  })
  const responders = new Set(options.swarm ? [principal] : [])
  for (const id of options.responders ?? []) {
    if (!isPrincipalId(id)) throw new Failed({
      class: 'usage',
      reason: 'invalid_responder',
      message: '--responder needs a principal ID, not a handle or profile.',
      next: [{ instruction: 'Use the principal from vb whoami --json' }],
    })
    responders.add(id)
  }
  return {
    ...(options.swarm || options.agentOps ? { agentOps: true } : {}),
    ...(responders.size ? { attentionResponders: { '*': [...responders] } } : {}),
    ...(options.swarm ? { politburo: 1 } : {}),
  }
}
