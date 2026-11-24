import type { Role } from './model.ts'

export type Permission = 'read' | 'post' | 'react' | 'label' | 'sync' | 'manage'

export const jockeyChannels = Object.freeze({ '*': 'all' } as const)

export function channelsFor(role: Role, partyId: string, board: 'repo' | 'party'): Record<string, Permission[]> {
  const talk: Permission[] = role === 'member' ? ['read', 'post', 'react'] : ['read', 'react']
  return board === 'repo'
    ? { intake: talk, 'work/': [...talk], 'mirror/': ['read'], [`party/${partyId}/`]: [...talk] }
    : { inbox: [...talk], outbox: [...talk], config: ['read'], decisions: ['read'], spend: ['read'] }
}
