import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { collectSprite, SpriteNotFinished } from './collect.ts'
import type { CollectSpriteOptions } from './collect.ts'
import type { CaptureLedger } from './ledger.ts'
import { spendRecords } from './spend.ts'
import { copyEnvelope } from './types.ts'
import type { Envelope, SpendRecord } from './types.ts'

export interface Attempt {
  name: string
  execution_id: string
  rc: number
  records: SpendRecord[]
  written: number
}

interface CaptureOptions {
  ledger: CaptureLedger
  envelope: Envelope
  name: string
  requested_route?: string | null
  now?: () => Date | string | number
}

export interface SuperviseOptions extends CaptureOptions {
  taskFile: string
  dir?: string
  cwd: string
  maxSeconds?: number
  restarts?: number
  worktree?: string
  base?: string
  launch?: (name: string, taskFile: string, cwd: string, maxSeconds: number) => Promise<void>
  newExecutionId?: () => string
  pollMs?: number
}

export const defaultSpriteDir = '/tmp/sprites'
export const executionId = () => `exec-${randomBytes(16).toString('hex')}`
export const validSpriteName = (name: string) => /^[\w.][\w.-]*$/.test(name) && !/^\.+$/.test(name)

export class SpriteLaunchFailed extends Error {}

const exec = promisify(execFile)
async function start(name: string, taskFile: string, cwd: string, maxSeconds: number): Promise<void> {
  const env = { ...process.env }
  delete env.PI_MODEL
  await exec('sprite-start', [name, resolve(cwd, taskFile), String(maxSeconds)], { cwd, env })
}

async function assertUnused(dir: string, sprite: string): Promise<void> {
  for (const suffix of ['', '.pid', '.rc', '.jsonl']) {
    const entry = await lstat(join(dir, sprite + suffix)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (entry) throw new Error('sprite name already used')
  }
}

export async function recordSprite(opts: CaptureOptions, collect: CollectSpriteOptions): Promise<Attempt> {
  const { ledger, envelope, name, requested_route, now } = opts
  const rows = await collectSprite(name, collect)
  const rc = rows[0]?.rc
  if (rc === undefined) throw new Error('sprite collector returned no records')
  const records = spendRecords(rows, {
    envelope, requested_route, source_version: 'bench-run@1',
    now: () => {
      const time = now?.() ?? new Date()
      return typeof time === 'number' ? new Date(time) : time
    },
  })
  let written = 0
  for (const record of records) if ((await ledger.append(record)).written) written++
  return { name, execution_id: envelope.trace.execution_id, rc, records, written }
}

async function waitForExit(path: string, deadline: number, pollMs: number, clock: () => number) {
  while (clock() < deadline) {
    const rc = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return ''
    })
    if (rc.trim()) return
    const left = deadline - clock()
    if (left > 0) await sleep(Math.min(pollMs, left))
  }
  throw new SpriteNotFinished('sprite did not finish')
}

export async function supervise(opts: SuperviseOptions): Promise<{ attempts: Attempt[] }> {
  const {
    ledger, name, taskFile, cwd, dir = defaultSpriteDir, maxSeconds = 2400, restarts = 0,
    launch = start, newExecutionId = executionId, pollMs = 2000, worktree, base, now,
  } = opts
  const initial = copyEnvelope(opts.envelope)
  if (initial.tier !== 'sprite') throw new Error('sprite supervision requires tier sprite')
  if (!validSpriteName(name)) throw new Error('invalid sprite name')
  if (!Number.isSafeInteger(restarts) || restarts < 0 || !Number.isSafeInteger(maxSeconds) || maxSeconds <= 0 ||
      !Number.isFinite(pollMs) || pollMs < 0) throw new Error('invalid supervision limits')
  if ((worktree === undefined) !== (base === undefined)) throw new Error('worktree and base must be provided together')
  const collect = worktree !== undefined && base !== undefined ? { dir, worktree, base } : { dir }
  const clock = now ? () => new Date(now()).getTime() : () => performance.now()
  const attempts: Attempt[] = []
  const ids = new Set<string>()

  const attemptName = (i: number) => i === 0 ? name : `${name}.r${i}`
  for (let i = 0; i <= restarts; i++) await assertUnused(dir, attemptName(i))

  for (let i = 0; i <= restarts; i++) {
    const sprite = attemptName(i)
    const id = i === 0 ? initial.trace.execution_id : newExecutionId()
    if (!id || ids.has(id)) throw new Error('sprite execution id must be fresh')
    ids.add(id)
    const envelope = { ...initial, trace: { ...initial.trace, execution_id: id } }
    await ledger.registerEnvelope(envelope)
    await assertUnused(dir, sprite)
    const deadline = clock() + (maxSeconds + 120) * 1000
    try {
      await launch(sprite, taskFile, cwd, maxSeconds)
    } catch {
      throw new SpriteLaunchFailed('sprite launch failed')
    }
    await waitForExit(join(dir, `${sprite}.rc`), deadline, pollMs, clock)
    const attempt = await recordSprite({ ...opts, name: sprite, envelope }, collect)
    attempts.push(attempt)
    if ([0, 130, 137, 143].includes(attempt.rc)) break
  }
  return { attempts }
}
