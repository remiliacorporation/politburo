// A board kept in this process, which `@vercel/board/backend-local` exports: on the board's log and its
// engine, with its pieces chosen here.
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { a2 } from './a2.ts'
import type { Backend, BoardBinding, Caller, ProtocolMethods, Trust } from './backend.ts'
import { fsBlob, memoryBlob } from './blob.ts'
import { HttpError } from './errors.ts'
import { METHODS } from './routing.ts'
import { localScheduler, type LocalScheduler } from '../scheduler/local.ts'
import { lockDirectory } from '../store/directory-lock.ts'
import type { BoardStore } from '../store/types.ts'
import type { AttentionResponders } from '../contract/attention.ts'
import type { EvidencePolicy } from '../contract/evidence.ts'
import type { WorkLifecycleOptions } from './tasks.ts'

export type LocalOptions = {
  /**
   * Where it keeps its files: `.board` under the working directory by default. Each board is one
   * SQLite file there, `local.db` for the default board and one named for the board otherwise,
   * whatever its team, with its attachments in the folder of the same name.
   */
  dir?: string
  /** Keeps the board in memory, attachments too, for tests: nothing is written, and it's gone with the process. */
  memory?: boolean
  /** Opt in to staged work for new tasks on this board. */
  workLifecycle?: WorkLifecycleOptions
  /** Opt in to commit evidence at task completion and, separately, to evidence-backed dependencies. */
  workEvidence?: EvidencePolicy
  /** Enables structured attention. Lists verified responders by exact channel or `*` for all channels. */
  attentionResponders?: AttentionResponders
  /** Enables the fork's agent registry, intents, and health checks. Off by default. */
  agentOps?: boolean
  /** The Politburo discovery version on a swarm board. */
  politburo?: 1
  /** How many seconds a run probe's report stays fresh, subject to its intent and lease deadlines. Default: 30. */
  agentHealthFreshnessSeconds?: number
}

/** A board kept in this process. `close()` closes its file, once nothing uses it. */
export type LocalBackend = Backend & {
  /** Stops its timers and closes the board's file. What was still to send doesn't, as after a restart. */
  close(): Promise<void>
}

/** A board's name that is its own file's: lowercase letters, digits, `_`, and `-`, and no device name Windows keeps. */
const PLAIN = /^[a-z0-9][a-z0-9_-]{0,63}$/
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/

/**
 * The file a board keeps, without its extension, from its name alone: `local` for the default
 * board, a plain name as it is (whatever its case: names match that way), and any other name,
 * `Security Team` say, as letters and dashes, a `.`, and a hash of it. No plain name has a `.`,
 * and the hash is long enough that no one finds two names that share it, so no two names
 * share a file, and none is `local`'s.
 */
export function localFile(name: string | null): string {
  if (name === null) return 'local'
  const lower = name.toLowerCase()
  if (PLAIN.test(lower) && lower !== 'local' && !RESERVED.test(lower)) return lower
  const slug = lower.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'board'
  return `${slug}.${createHash('sha256').update(lower).digest('hex').slice(0, 32)}`
}

/** Why a file couldn't be opened, in a few words. */
function unwritable(error: unknown): string {
  const { code, message } = error as { code?: unknown; message?: unknown }
  if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM' || /unable to open database|readonly database/i.test(String(message)))
    return "this filesystem isn't writable here"
  return String(message ?? error).split('\n')[0]!
}

function noStore(path: string, error: unknown) {
  return new HttpError(500, 'no_store', `can't open the board at ${path}: ${unwritable(error)}`)
}

/** Take a reference to an existing directory, including for serve's pre-open migration. */
export function lockLocalDirectory(dir: string, file = 'local'): () => void {
  let unlock: (() => void) | null
  try {
    unlock = lockDirectory(dir)
  } catch (error) {
    throw noStore(join(dir, `${file}.db`), error)
  }
  if (!unlock) throw new HttpError(409, 'board_dir_locked', "another process owns this board's directory", {
    origin: 'handle', hint: 'Use --url to reach the board in that process.',
  })
  return unlock
}

/**
 * A board kept in this process: in SQLite under `.board/` (or `dir`), one file per board's name
 * (whatever `board({ team })` says: there's one team here),
 * its attachments next to it, and a scheduler whose timers run here, so schedules send, and
 * watchers and sync retry, while the process runs. `memory` keeps it all in memory, for tests.
 * A restart drops pending timers, so it's for development, `vb serve`, tests, and working offline,
 * never serverless functions.
 */
export function local(options: LocalOptions = {}): LocalBackend {
  const dir = resolve(options.dir ?? '.board')
  const workLifecycle = options.workLifecycle && { scopers: [...options.workLifecycle.scopers] }
  let binding: BoardBinding | null = null
  let opening: Promise<{ backend: ReturnType<typeof a2>; close(): Promise<void> }> | null = null

  /** The board, opened on its first use: binding does no I/O. One that didn't open is tried again on the next call. */
  function open() {
    if (!binding) throw new Error("local: this backend isn't serving a board yet: pass it to board({ backend })")
    const bound = binding
    if (opening) return opening
    const opened = (async () => {
      const file = localFile(bound.name)
      let store: BoardStore
      let unlock: (() => void) | null = null
      if (options.memory) store = (await import('../store/memory.ts')).memory()
      else {
        const { mkdir } = await import('node:fs/promises')
        const { sqlite } = await import('../store/sqlite.ts')
        const path = join(dir, `${file}.db`)
        try {
          await mkdir(dir, { recursive: true, mode: 0o700 })
          unlock = lockLocalDirectory(dir, file)
          store = sqlite({ path })
        } catch (error) {
          unlock?.()
          if (error instanceof HttpError) throw error
          throw noStore(path, error)
        }
      }
      const scheduler = localScheduler()
      const close = async () => {
        // Its timers first: one that fired after would run against a closed file.
        scheduler.stop()
        await store.close()
        unlock?.()
      }
      try {
        const backend = a2({
          store, scheduler, blob: options.memory ? memoryBlob() : fsBlob(join(dir, file)),
          ...(workLifecycle ? { workLifecycle } : {}),
          ...(options.workEvidence ? { workEvidence: options.workEvidence } : {}),
          ...(options.attentionResponders !== undefined ? { attentionResponders: options.attentionResponders } : {}),
          agentOps: options.agentOps === true,
          ...(options.politburo === 1 ? { politburo: 1 } : {}),
          ...(options.agentHealthFreshnessSeconds === undefined ? {} : { agentHealthFreshnessSeconds: options.agentHealthFreshnessSeconds }),
        })
        backend.bind(bound)
        return { backend, close }
      } catch (error) {
        await close()
        throw error
      }
    })()
    opening = opened
    void opened.catch(() => { if (opening === opened) opening = null })
    return opened
  }

  const methods = Object.fromEntries(
    METHODS.map((name) => [name, async (caller: Caller, input: never, signal: AbortSignal) => ((await open()).backend[name] as (...args: unknown[]) => unknown)(caller, input, signal)]),
  ) as unknown as ProtocolMethods

  return {
    ...methods,
    routes: [],
    // The board lives here: board() lets its people and own deployments in by default.
    keeps: true,
    supportsTaskAuthority: true,
    // `local()` is the backend board() sees. The flag lives on the engine it opens.
    enforcesCommitEvidence: async () => (await open()).backend.enforcesCommitEvidence(),
    trust: {
      grants: async () => (await open()).backend.trust.grants(),
      joined: async (digest, audience) => (await open()).backend.trust.joined(digest, audience),
    } satisfies Trust,
    bind(given: BoardBinding) {
      if (binding) throw new Error('local: this backend already serves a board: create one local() per board()')
      binding = given
    },
    async close() {
      const opened = opening
      opening = null
      const board = opened && (await opened.catch(() => null))
      await board?.close()
    },
  }
}
