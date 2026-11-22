import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { block, BoardError, type Board, type MessageView } from '@vercel/board'
import { isoNow, mirrorKinds, mirrorReasons, validRepo, type MirrorClock, type MirrorItem,
  type MirrorKind, type MirrorRecord, type MirrorStatus } from './types.ts'

const name = 'swarm-mirror'
const string = { type: 'string' }
const boolean = { type: 'boolean' }
const common = { repo: string, kind: { enum: [...mirrorKinds] }, observedAt: { type: 'string', format: 'date-time' } }
const shape = (properties: Record<string, unknown>, ...required: string[]) => ({
  type: 'object', properties, required: [...Object.keys(common), ...required], additionalProperties: false,
})

/** Run once with a board handle allowed to register schemas. */
export async function registerMirrorSchema(board: Pick<Board, 'createSchema'>) {
  await board.createSchema({ name, version: 1, schema: { type: 'object', oneOf: [
    shape({ ...common, key: string, state: { enum: ['open', 'closed', 'merged', 'gone'] },
      draft: boolean, title: string, author: string, base: string, updatedAt: string,
      head: { type: 'object', properties: { ref: string, sha: string }, required: ['ref', 'sha'], additionalProperties: false },
    }, 'key', 'state'),
    shape({ ...common, complete: boolean, reason: { enum: [...mirrorReasons] } }, 'complete'),
  ] } })
}

function channel(repo: string) {
  if (!validRepo(repo)) throw new TypeError('invalid mirror repo')
  // Board paths are lowercase and cannot contain dots or start with punctuation.
  return 'mirror/' + repo.toLowerCase().split('/').map((part) =>
    /^[a-z0-9][a-z0-9_-]*$/u.test(part) && !part.startsWith('0-') ? part : `0-${Buffer.from(part).toString('hex')}`,
  ).join('/')
}

function recordId({ repo, kind, key }: MirrorItem) {
  const id = `mirror:${repo.toLowerCase()}:${kind}:${key}`
  // Board caps caller IDs at 200 characters; Git branch names can exceed that.
  return id.length <= 200 ? id : `mirror-long:${createHash('sha256').update(id).digest('hex')}`
}

type Scope = { repo: string; kind: MirrorKind }
type Data = MirrorRecord | (Scope & MirrorStatus)
type Counts = { created: number; changed: number }
const writeLabel = 'mirror.write'
const statusLabel = 'mirror.status'
const payload = (message: MessageView, author: string): Data | undefined =>
  message.by.actor === author && message.re === null && !message.deleted
    ? message.blocks.find((entry) => entry.schema === name && entry.version === 1)?.data as Data | undefined : undefined
const content = ({ observedAt: _, ...rest }: Data) => rest
const hasCode = (error: unknown, code: string) => error instanceof BoardError && error.code === code

/** Use one writer identity per repo and reserve its mirror channel for this store. */
export function mirrorStore({ board, author, now }: {
  board: Pick<Board, 'post' | 'posted' | 'edit' | 'threads'>; author: string; now: MirrorClock
}) {
  async function save(id: string, row: Data, insertOnly = false): Promise<keyof Counts | undefined> {
    const path = channel(row.repo)
    const text = block(`${name}@1`, row)
    const nonce = randomUUID()
    for (;;) {
      let message: MessageView
      try { message = await board.posted(id) } catch (error) {
        if (!hasCode(error, 'post_not_found')) throw error
        message = await board.post(path, { id, noSync: true, text, labels: {
          [writeLabel]: nonce, ...('complete' in row ? { [statusLabel]: row.kind } : {}),
        } })
        if (message.by.actor === author && message.labels[writeLabel] === nonce) return 'created'
      }
      const previous = payload(message, author)
      if (!previous) throw new Error('invalid mirror board record')
      if (insertOnly || previous.observedAt > row.observedAt || isDeepStrictEqual(previous, row)) return
      try {
        await board.edit(message.id, text, { revision: message.revision })
        return isDeepStrictEqual(content(previous), content(row)) ? undefined : 'changed'
      } catch (error) {
        if (!hasCode(error, 'revision_conflict')) throw error
      }
    }
  }

  async function* scan(repo: string, kind?: MirrorKind) {
    repo = repo.toLowerCase()
    const cursors = new Set<string>()
    let before: string | null | undefined
    do {
      if (before) {
        if (cursors.has(before)) throw new Error('mirror board repeated a threads cursor')
        cursors.add(before)
      }
      const page = await board.threads({ channel: channel(repo), limit: 500,
        ...(before ? { before } : {}), ...(kind ? { label: { [statusLabel]: kind } } : {}),
      })
      for (const { message } of page.threads) {
        const row = payload(message, author)
        if (row?.repo === repo) yield row
      }
      if (page.older === undefined && page.threads.length === 500) throw new Error('mirror board cannot page threads')
      before = page.older
    } while (before)
  }

  return {
    async upsert(records: readonly (MirrorItem & { observedAt?: string })[], { insertOnly = false } = {}): Promise<Counts> {
      const counts = { created: 0, changed: 0 }
      for (const record of records) {
        const outcome = await save(recordId(record), {
          ...record, repo: record.repo.toLowerCase(), observedAt: record.observedAt ?? isoNow(now),
        }, insertOnly)
        if (outcome) counts[outcome]++
      }
      return counts
    },
    async list({ repo, kind, state }: { repo: string; kind?: MirrorKind; state?: MirrorRecord['state'] }) {
      const records = new Map<string, MirrorRecord>()
      for await (const row of scan(repo)) {
        if ('key' in row && (!kind || row.kind === kind) && (!state || row.state === state)) records.set(recordId(row), row)
      }
      return [...records.values()]
    },
    status: {
      async read({ repo, kind }: Scope): Promise<MirrorStatus | undefined> {
        for await (const row of scan(repo, kind)) {
          if ('complete' in row && row.kind === kind) {
            const { repo: _, kind: __, ...status } = row
            return status
          }
        }
      },
      async write({ repo, kind }: Scope, { complete, observedAt = isoNow(now), reason }: Omit<MirrorStatus, 'observedAt'> & { observedAt?: string }) {
        const fixed = mirrorReasons.find((entry) => entry === reason) ?? 'unexpected_response'
        repo = repo.toLowerCase()
        await save(`mirror-status:${repo}:${kind}`, { repo, kind, complete, observedAt, ...(!complete ? { reason: fixed } : {}) })
      },
    },
  }
}

export type MirrorStore = ReturnType<typeof mirrorStore>
