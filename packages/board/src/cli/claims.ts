// Where the CLI keeps the claims it holds, between commands: a claim answers its `epoch` and
// `token` once, and every write the claim makes needs both, so `vb tasks complete 812` is one
// process and `vb tasks claim 812` was another.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { configDir } from '../client/node.ts'

/** A claim as the CLI keeps it: what its writes carry, and when its lease ends. */
export type HeldClaim = { epoch: number; token: string; until: string }

export type ClaimProof = Pick<HeldClaim, 'epoch' | 'token'>

const matchesClaim = (claim: HeldClaim | null | undefined, only: ClaimProof) =>
  claim?.epoch === only.epoch && claim.token === only.token

/** The claims one run holds on one board, as whoever it writes as, by task. */
export type Claims = {
  get(task: string): Promise<HeldClaim | null>
  put(task: string, claim: HeldClaim): Promise<void>
  /** Forget the claim only if its epoch and token still match. */
  drop(task: string, only: ClaimProof): Promise<void>
}

type Stored = HeldClaim & { board: string; task: string; profile: string | null }

/** A claim whose lease ended this long ago is no one's to settle: its file goes when another is written. */
const DEAD_MS = 24 * 60 * 60_000

/** Claim mutations only rename or compare and unlink a local file. A marker this old is abandoned. */
const LOCK_MAX_AGE_MS = 30_000

/** The claims directory: `~/.config/board/claims`, or under `XDG_CONFIG_HOME`, as the CLI's tokens are. */
export const claimsDir = () => join(configDir(), 'claims')

/**
 * The file one claim lives in: named for its board, task, and profile together, hashed, so a name
 * says nothing of any of them, and never holds a token.
 */
const fileOf = (board: string, task: string, profile: string | null) =>
  join(claimsDir(), `${createHash('sha256').update(JSON.stringify([board, task, profile])).digest('hex').slice(0, 32)}.json`)

async function read(file: string): Promise<Stored | null> {
  try {
    const stored = JSON.parse(await readFile(file, 'utf8')) as Partial<Stored>
    if (typeof stored.epoch !== 'number' || typeof stored.token !== 'string' || typeof stored.until !== 'string') return null
    return stored as Stored
  } catch {
    return null
  }
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code

function ownerIsDead(owner: string) {
  const pid = Number(owner.split('.')[0])
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return errorCode(error) === 'ESRCH'
  }
}

async function abandonedOwner(dir: string, owner: string) {
  if (ownerIsDead(owner)) return true
  // A crashed writer's PID may already belong to an unrelated process.
  try {
    return Date.now() - (await stat(join(dir, owner))).mtimeMs > LOCK_MAX_AGE_MS
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

async function removeEmpty(dir: string) {
  await rmdir(dir).catch((error: unknown) => {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errorCode(error) ?? '')) throw error
  })
}

async function reapLock(lock: string) {
  const owners = await readdir(lock).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  })
  // Remove only the abandoned owner's unique marker, never a successor's. The last
  // rmdir can remove only an empty directory, even if a new owner beat us to it.
  for (const owner of owners) {
    if (!(await abandonedOwner(lock, owner))) return
    await removeEmpty(join(lock, owner))
  }
  await removeEmpty(lock)
}

/** Lock mutations of one claim without moving the file that readers use. */
async function withClaimLock(file: string, mutate: () => Promise<void>, wait = true) {
  const lock = `${file}.lock`
  const owner = `${process.pid}.${randomUUID()}`
  const pending = `${file}.${owner}.lock-tmp`
  const deadline = performance.now() + 5_000
  let acquired = false
  try {
    // Publish the owner's identity atomically. Rename cannot replace a nonempty lock.
    await mkdir(join(pending, owner), { recursive: true, mode: 0o700 })
    while (!acquired) {
      try {
        await rename(pending, lock)
        acquired = true
      } catch (error) {
        if (!['ENOTEMPTY', 'EEXIST', 'EPERM'].includes(errorCode(error) ?? '')) throw error
        // Pruning is best effort and never waits for an unrelated writer.
        if (!wait) return
        await reapLock(lock)
        if (performance.now() >= deadline) throw new Error('timed out waiting to update the saved task claim')
        await delay(10)
      }
    }
    await mutate()
  } finally {
    const dir = acquired ? lock : pending
    await removeEmpty(join(dir, owner))
    await removeEmpty(dir)
  }
}

/** Removes expired claims and abandoned writes, without waiting for a lock. */
async function prune(now: number) {
  const expired = (claim: Stored | null) => claim && now - Date.parse(claim.until) > DEAD_MS
  for (const name of await readdir(claimsDir()).catch(() => [])) {
    const file = join(claimsDir(), name)
    if (name.endsWith('.json')) {
      if (expired(await read(file))) {
        await withClaimLock(file, async () => {
          if (expired(await read(file))) await unlink(file)
        }, false).catch(() => {})
      }
    } else if (name.endsWith('.lock')) {
      await reapLock(file).catch(() => {})
    } else if (name.endsWith('.lock-tmp')) {
      const owner = name.split('.').slice(-3, -1).join('.')
      if (await abandonedOwner(file, owner)) {
        await removeEmpty(join(file, owner))
        await removeEmpty(file)
      }
    } else {
      // An abandoned write or a tombstone left by an older CLI.
      const info = await stat(file).catch(() => null)
      if (info && now - Math.max(info.mtimeMs, info.ctimeMs) > DEAD_MS) await unlink(file).catch(() => {})
    }
  }
}

/**
 * Claims in files, one per board, task, and profile: only this user reads them (the directory is
 * 0700, each file 0600), and each is written whole or not at all. `board` is the board's own URL,
 * asked for only when a claim is read or written; `profile` is the profile this run writes as, as
 * an actor's ID has it, or null as yourself. A claim is its actor's: a run as another profile is
 * another actor, and holds none of it.
 */
export function fileClaims(board: () => Promise<string>, profile: string | null): Claims {
  let key: Promise<string> | null = null
  const at = async (task: string) => fileOf(await (key ??= board()), task, profile)
  return {
    async get(task) {
      const stored = await read(await at(task))
      // The name is a hash: what's in the file says which claim it is.
      if (!stored || stored.board !== (await key) || stored.task !== task || stored.profile !== profile) return null
      return { epoch: stored.epoch, token: stored.token, until: stored.until }
    },
    async put(task, claim) {
      const file = await at(task)
      await mkdir(claimsDir(), { recursive: true, mode: 0o700 })
      const stored: Stored = { board: (await key)!, task, profile, ...claim }
      await (async () => {
        // Beside it, then into place: readers find the old claim or the new one, never half of one.
        const partial = `${file}.${process.pid}.${randomUUID()}.tmp`
        try {
          await writeFile(partial, JSON.stringify(stored), { mode: 0o600 })
          await withClaimLock(file, () => rename(partial, file))
        } catch (error) {
          await unlink(partial).catch(() => {})
          throw error
        }
      })()
      await prune(Date.now()).catch(() => {})
    },
    async drop(task, only) {
      const file = await at(task)
      await withClaimLock(file, async () => {
        if (matchesClaim(await read(file), only)) await unlink(file)
      })
    },
  }
}

/** A handle's claims, kept in this process: what `vb()` holds, where the board is a handle and no file is the caller's. */
const held = new WeakMap<object, Map<string, HeldClaim>>()

/** Claims kept in memory, for as long as the process and the handle last: one per task and profile, as the files are. */
export function memoryClaims(board: object, profile: string | null): Claims {
  const claims = held.get(board) ?? held.set(board, new Map()).get(board)!
  const at = (task: string) => JSON.stringify([task, profile])
  return {
    get: async (task) => claims.get(at(task)) ?? null,
    put: async (task, claim) => void claims.set(at(task), claim),
    async drop(task, only) {
      const key = at(task)
      if (matchesClaim(claims.get(key), only)) claims.delete(key)
    },
  }
}

/**
 * Claims by a token the caller chose, kept nowhere: a task's claim is this token's while the task
 * is claimed, at the epoch the board shows, and the board says whether the token holds it. So any
 * call with the token renews and settles the claim, on any handle, process, or instance.
 */
export function tokenClaims(board: { thread(id: string, range: { limit: number }): Promise<{ message: { task?: { state: string; epoch: number; claim: { until: string } | null } | null } }> }, token: string): Claims {
  return {
    async get(task) {
      const held = (await board.thread(task, { limit: 1 })).message.task
      if (held?.state !== 'claimed' || !held.claim) return null
      return { epoch: held.epoch, token, until: held.claim.until }
    },
    put: async () => {},
    // There is no saved claim to compare or drop.
    drop: async (_task, _only) => {},
  }
}
