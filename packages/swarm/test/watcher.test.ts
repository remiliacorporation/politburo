import assert from 'node:assert/strict'
import { test } from 'node:test'
import { board } from '@vercel/board'
import { oidcTokens } from '@vercel/board/access'
import { local } from '@vercel/board/backend-local'
import { BOARD_URL, caller, localUserToken, testLocal } from '../../board/test/tokens.ts'
import {
  acceptVerdict, createWatcher, type Attempt, type CodeHost, type Control, type Observation,
  type RemoteStatus, type StatusRefusal, type StatusRow,
} from '../src/watcher/index.ts'

const binding = { session: 'session', briefDigest: 'digest', attempt: 'a', generation: 1 }
const sha = (n: number) => n.toString(16).padStart(40, '0')
const commit = sha(1000), other = sha(1001)
const working = (sequence: number) => ({ ...binding, version: 1, sequence, state: 'working' } as const)
const finished = (sequence: number) => ({ ...working(sequence), state: 'finished', publishedSha: commit } as const)
function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6D2B79F5) | 0
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 2 ** 32
  }
}
const seeds = new Set([13, 66, 215, 257, ...(process.env.SWARM_SEED === undefined
  ? Array.from({ length: Number(process.env.SWARM_SEEDS ?? 100) }, (_, i) => i)
  : [Number(process.env.SWARM_SEED)])])
async function seeded(run: (rng: () => number, trace: string[]) => Promise<void>) {
  const errors = []
  for (const seed of seeds) {
    const trace: string[] = []
    try { await run(mulberry32(seed), trace) }
    catch (cause) { errors.push(new Error(`seed=${seed} trace=${trace.join(' → ')}`, { cause })) }
  }
  if (errors.length) throw new AggregateError(errors, errors[0]!.message)
}

// Ref snapshots, the host and the review journal are external boundaries.
function fixture(epoch = 0, control: Control = { epoch: () => epoch }, jitter = () => 0, pollMs = 10) {
  const attempt: Attempt = { repo: 'acme/web', branch: 'work', title: 'work', statusBranch: 'a/status',
    expected: binding, epoch, taskId: 't', round: 1, launchedAt: 0, staleMs: 1_000_000,
    submitter: 'worker', reviewer: 'reviewer' }
  const f = { head: sha(1), text: JSON.stringify(finished(1)), descends: true, now: 0,
    branchHead: commit, prHead: commit, checkSha: commit, failRead: false, failRef: false,
    pr: null as Awaited<ReturnType<CodeHost['findPr']>>,
    afterStatusRead: undefined as (() => void) | undefined,
    duringChecks: undefined as (() => void) | undefined,
    afterOpen: undefined as (() => void) | undefined,
    observations: [] as Observation[], writes: [] as string[], reviews: [] as string[] }
  let saved: StatusRow | undefined
  const watcher = createWatcher({ control, jitter, pollMs, now: () => f.now,
    table: { get: () => structuredClone(saved), set: (_, row) => { saved = structuredClone(row) } },
    refs: () => ({ read: async () => {
      if (f.failRef) throw new Error('ref unavailable')
      const snapshot = { head: f.head, text: f.text }
      f.afterStatusRead?.()
      return snapshot
    }, isAncestor: async () => f.descends }),
    host: () => ({ findPr: async () => f.pr, headSha: async ref => typeof ref === 'string' ? f.branchHead : f.prHead,
      openDraftPr: async ({ sha }) => {
        f.writes.push('open')
        f.prHead = sha ?? f.branchHead
        f.pr = { number: 1, state: 'draft' }
        f.afterOpen?.()
        return f.pr
      },
      convertToDraft: async (pr, head) => { f.writes.push(`draft:${pr}:${head}`); f.pr = { number: pr, state: 'draft' } },
      runChecks: async () => {
        if (f.failRead) throw new Error('host unavailable')
        f.duringChecks?.()
        return { sha: f.checkSha, state: 'pass' }
      } }),
    observer: { observe: event => { f.observations.push(event) } },
    reviewer: { start: ({ commit }) => { f.reviews.push(commit) } },
  })
  return Object.assign(f, { tick: (now: number, work = attempt) => { f.now = now; return watcher.tick([work]) },
    cursor: () => saved?.cursor, last: () => f.observations.at(-1)!, attempt })
}

test('refused status never advances the cursor or authorizes a PR', () => seeded(async (rng, trace) => {
  const f = fixture()
  let cursor: ReturnType<typeof f.cursor>
  let step = 0
  // The oracle labels constructed inputs by the contract, not by re-parsing their JSON.
  async function drive(name: string, record: RemoteStatus, reason?: StatusRefusal, options: {
    head?: string; text?: string; descends?: boolean
  } = {}) {
    const now = step++ * 10
    f.head = options.head ?? sha(step)
    f.text = options.text ?? JSON.stringify(record)
    f.descends = options.descends ?? true
    trace.push(`${name}@${record.sequence}/${f.head.slice(-3)}`)
    const before = f.cursor()?.sequence ?? 0
    if (!reason) cursor = { ...record, head: f.head, receivedAt: now }
    await f.tick(now)
    assert.equal(f.observations.length, step)
    assert.deepEqual(f.cursor(), cursor)
    assert.ok((f.cursor()?.sequence ?? 0) >= before)
    const refused = reason !== undefined && reason !== 'no_op'
    assert.deepEqual([f.last().status, f.last().reason, f.last().candidate], [
      refused ? 'refused' : cursor?.state, refused ? reason : undefined, cursor?.publishedSha,
    ])
    assert.deepEqual(f.writes, cursor?.state === 'finished' ? ['open'] : [])
    assert.deepEqual(f.reviews, cursor?.state === 'finished' ? [commit] : [])
  }
  await drive('initial', working(2))
  const cases = ['progress', 'gap', 'duplicate', 'older', 'equivocation', 'rewind', 'session', 'briefDigest',
    'attempt', 'generation', 'missing generation', 'nested unknown', 'duplicate key', 'control', 'short sha', 'nonhex sha']
  while (cases.length) {
    const [name] = cases.splice(Math.floor(rng() * cases.length), 1)
    const { sequence, head } = cursor!
    const next = finished(sequence + 1)
    switch (name) {
      case 'progress': await drive(name, working(sequence + 1)); break
      case 'gap': await drive(name, working(sequence + 2 + Math.floor(rng() * 20))); break
      case 'duplicate': await drive(name, working(sequence), 'no_op', { head }); break
      case 'older': await drive(name, finished(sequence - 1), 'status_out_of_order'); break
      case 'equivocation': await drive(name, finished(sequence), 'status_out_of_order'); break
      case 'rewind': await drive(name, next, 'status_out_of_order', { head: sha(0), descends: false }); break
      case 'session': case 'briefDigest': case 'attempt':
        await drive(name, { ...next, [name]: 'wrong' }, 'binding_mismatch'); break
      case 'generation': await drive(name, { ...next, generation: 2 }, 'generation_mismatch'); break
      case 'missing generation': await drive(name, next, 'generation_mismatch', {
        text: JSON.stringify({ ...next, generation: undefined }),
      }); break
      case 'nested unknown': await drive(name, next, 'invalid_status', {
        text: JSON.stringify({ ...next, metadata: { extra: true } }),
      }); break
      case 'duplicate key': await drive(name, next, 'invalid_status', {
        text: `{"sequence":0,${JSON.stringify(next).slice(1)}`,
      }); break
      case 'control': await drive(name, { ...next, session: 'session\u0000' }, 'invalid_status'); break
      case 'short sha': case 'nonhex sha':
        await drive(name, { ...next, publishedSha: name === 'short sha' ? 'abc' : 'z'.repeat(40) }, 'invalid_status'); break
    }
  }
  await drive('finished', finished(cursor!.sequence + 1))
  await drive('finished again', { ...finished(cursor!.sequence + 1), publishedSha: other }, 'status_out_of_order')
  await drive('working after finish', working(cursor!.sequence + 1), 'status_out_of_order')
}))

for (const [field, lexeme] of [['generation', '1.0000000000000001'], ['sequence', '1e-9999'],
  ['sequence', '-0'], ['sequence', '1000000000000000']]) {
  test(`invalid ${field} lexeme ${lexeme} must not advance the cursor or open a draft`, async () => {
    const f = fixture()
    f.text = JSON.stringify(finished(0)).replace(new RegExp(`"${field}":\\d+`), `"${field}":${lexeme}`)
    await f.tick(0)
    assert.deepEqual([f.last().reason, f.cursor(), f.writes], ['invalid_status', undefined, []])
  })
}

test('a branch move during the control read must not open on the new tip', async () => {
  const f = fixture(0, { epoch: () => { f.branchHead = other; return 0 } })
  await f.tick(0)
  assert.deepEqual([f.branchHead, f.writes, f.last().head, f.reviews], [other, ['open'], commit, [commit]])
})

test('a changed head after draft creation must be flagged stale and redrafted if ready', async () => {
  const f = fixture()
  f.afterOpen = () => { f.prHead = other; f.pr = { number: 1, state: 'ready' } }
  await f.tick(0)
  const { status, stale, reason, voidedHead, check, draftPending } = f.last()
  assert.deepEqual([status, stale, reason, voidedHead, check, draftPending, f.writes, f.reviews],
    ['stale', true, 'head_changed', commit, 'unknown', false, ['open', `draft:1:${other}`], []])
})

test('a pause after the status read must block draft creation', async () => {
  let calls = 0
  const control: Control = { epoch: () => ++calls >= 2 ? 'unknown' : 0 }
  const f = fixture(0, control)
  // An independent control read at the snapshot boundary moves the fake toward pause.
  f.afterStatusRead = () => { control.epoch() }
  await f.tick(0)
  assert.equal(f.last().status, 'finished')
  assert.deepEqual([f.writes, f.reviews], [[], []])
})

test('paused and old epochs observe without host writes or reviewer starts', async t => {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({ backend, url: BOARD_URL, authenticate: oidcTokens({ local: testLocal }) })
  const request = caller(team.fetch, await localUserToken('watcher-test'))
  const control: Control = { async epoch() {
    const status = await team.status()
    return status.paused ? 'unknown' : status.pauseEpoch
  } }
  await seeded(async (rng, trace) => {
    if ((await team.status()).paused) assert.equal((await request('POST', '/control/resume', { reason: 'test' })).status, 200)
    const epoch = await control.epoch()
    assert.ok(typeof epoch === 'number')
    const unopened = fixture(epoch, control), existing = fixture(epoch, control)
    existing.pr = { number: 1, state: 'ready' }
    for (let i = 0; i < 10; i++) {
      const action = i === 0 ? 'pause' : i === 1 ? 'resume' : rng() < 0.4 ? 'toggle' : 'tick'
      const command = action === 'toggle' ? (await team.status()).paused ? 'resume' : 'pause' : action
      trace.push(command)
      if (command !== 'tick') assert.equal((await request('POST', `/control/${command}`, { reason: 'test' })).status, 200)
      const live = await control.epoch()
      assert.notEqual(live, epoch)
      if (i === 1) assert.equal(typeof live, 'number')
      if (i === 2) existing.prHead = other
      for (const f of [unopened, existing]) {
        await f.tick(i * 10)
        assert.equal(f.last().status, 'finished')
        assert.equal(f.last().check, f === existing && i < 2 ? 'pass' : 'unknown')
        assert.deepEqual([f.writes, f.reviews], [[], []])
      }
    }
  })
})

test('duplicate snapshots do not postpone staleness or trigger a relaunch', async () => {
  const f = fixture(), work = { ...f.attempt, staleMs: 30 }
  f.text = JSON.stringify(working(1))
  for (const now of [0, 10, 20, 30, 40]) await f.tick(now, work)
  assert.deepEqual(f.observations.map(e => [e.status, e.stale]), [
    ['working', false], ['working', false], ['working', false], ['stale', true], ['stale', true],
  ])
  f.head = sha(2); f.text = JSON.stringify(working(2))
  await f.tick(50, work)
  assert.deepEqual([f.last().status, f.last().stale, f.writes, f.reviews], ['working', false, [], []])
})

test('a mismatched check stays unknown and a push voids review and redrafts once', async () => {
  const f = fixture()
  f.checkSha = other
  await f.tick(0)
  assert.deepEqual([f.last().check, f.reviews], ['unknown', []])
  f.checkSha = commit
  await f.tick(10)
  assert.deepEqual([f.last().check, f.reviews], ['pass', [commit]])
  f.pr = { number: 1, state: 'ready' }; f.prHead = other
  await f.tick(20)
  await f.tick(30)
  assert.deepEqual(f.writes, ['open', `draft:1:${other}`])
  assert.deepEqual([f.last().voidedHead, f.last().check, f.last().draftPending, f.reviews], [commit, 'unknown', false, [commit]])
})

test('a push during checks must not report a pass, even if the retired head returns', async () => {
  const f = fixture()
  f.duringChecks = () => { f.prHead = other }
  await f.tick(0)
  assert.deepEqual(f.observations.map(e => [e.head, e.check, e.voidedHead]), [[other, 'unknown', commit]])
  assert.deepEqual(f.reviews, [])
  f.duringChecks = undefined
  f.prHead = commit
  await f.tick(10)
  assert.deepEqual([f.last().head, f.last().check, f.last().voidedHead, f.reviews], [commit, 'unknown', commit, []])
})

test('failed reads back off with bounded jitter and never report a pass', () => seeded(async (rng, trace) => {
  let jitter = 0
  const f = fixture(0, undefined, () => jitter, 1000)
  f.failRead = true
  let now = 0
  for (const base of [1000, 2000, 4000, 8000, 16000, 32000, 64000]) {
    jitter = rng()
    const delay = Math.min(30_000, base * (1 + jitter))
    trace.push(`failure@${now}, retry in ${delay}ms`)
    const before = f.observations.length
    await f.tick(now)
    assert.equal(f.observations.length, before + 1)
    assert.deepEqual([f.last().status, f.last().check, f.reviews], ['unknown', 'unknown', []])
    now += delay
    await f.tick(now - 1)
    assert.equal(f.observations.length, before + 1)
  }
  f.failRead = false
  await f.tick(now)
  assert.deepEqual([f.last().check, f.reviews], ['pass', [commit]])
}))

test('repeated ref-read failures must lengthen the retry interval', async () => {
  const f = fixture()
  f.failRef = true
  for (const [index, now] of [0, 10, 30, 70].entries()) {
    if (now) {
      await f.tick(now - 1)
      assert.equal(f.observations.length, index)
    }
    await f.tick(now)
    assert.equal(f.observations.length, index + 1)
    assert.equal(f.last().status, 'unknown')
  }
  assert.deepEqual([f.cursor(), f.writes, f.reviews], [undefined, [], []])
})

test('stale commits and contradictory or unknown review levels cannot grant a verdict', () => {
  const clean = { outcome: 'clean', level: 'minor', commit, head: commit }
  for (const level of ['major', 'high', 'blocker']) {
    assert.deepEqual(acceptVerdict({ ...clean, level }), { reason: 'review_level_conflict' })
  }
  assert.deepEqual(acceptVerdict({ ...clean, outcome: 'findings', level: 'high' }), { level: 'major' })
  assert.deepEqual(acceptVerdict({ ...clean, level: 'critical' }), { reason: 'invalid_verdict' })
  assert.deepEqual(acceptVerdict({ ...clean, commit: other }), { reason: 'stale_verdict' })
  assert.deepEqual(acceptVerdict(clean), { level: 'minor' })
})
