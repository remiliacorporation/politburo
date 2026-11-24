import type { Board, MessageView, PostOptions, ReplyOptions } from '@vercel/board'
import { RegistryError, type Registry } from './model.ts'
import { principalOf } from './principal.ts'

function checkPartyId(partyId: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(partyId)) throw new RegistryError('party', 'invalid party id')
}

export function partyOf(message: MessageView): string | null {
  return message.labels?.party ?? null
}

export function partyOfRecord(message: MessageView, registry: Registry): string | null {
  const label = partyOf(message)
  const channelParty = /^party\/([^/]+)\//.exec(message.channel)?.[1]
  if (channelParty !== undefined) return label === null || label === channelParty ? channelParty : null
  if (label !== null) return label

  const author = message.by.principal.split('+', 1)[0]
  const isAuthor = (email: string) => principalOf(email).id === author
  if (registry.jockeys.some(isAuthor)) return null
  const parties = registry.parties.filter(({ members }) => members.some(({ email }) => isAuthor(email)))
  return parties.length === 1 ? parties[0]!.id : null
}

export function partyWriter(handle: Board, partyId: string) {
  checkPartyId(partyId)
  function checkChannel(channel: string): void {
    const [prefix, id] = channel.split('/')
    if (prefix === 'party' && id !== undefined && id !== partyId) {
      throw new Error('cannot write to another party channel')
    }
  }
  function stamp<T extends Omit<PostOptions, 'text'>>(text: string, options: T) {
    if (options.labels?.party !== undefined && options.labels.party !== partyId) {
      throw new Error('party label does not match the writer party id')
    }
    // The board requires label even on posts and replies; use a dispatcher or jockey, not a member.
    return { ...options, text, labels: { ...options.labels, party: partyId } }
  }
  function checked<T extends MessageView>(message: T): T {
    // A retry can return an earlier message without applying the new labels.
    if (partyOf(message) !== partyId) throw new Error('board returned a message without the requested party label')
    return message
  }
  return {
    async post(channel: string, text: string, options: Omit<PostOptions, 'text'> = {}) {
      checkChannel(channel)
      return checked(await handle.post(channel, stamp(text, options)))
    },
    async reply(id: string, text: string, options: Omit<ReplyOptions, 'text'> = {}) {
      const input = stamp(text, options)
      checkChannel((await handle.thread(id, { limit: 1 })).message.channel)
      return checked(await handle.reply(id, input))
    },
  }
}

export function rowsOfParty(handle: Board, partyId: string, query: Omit<NonNullable<Parameters<Board['threads']>[0]>, 'label'> = {}) {
  checkPartyId(partyId)
  return handle.threads({ ...query, label: { party: partyId } })
}
