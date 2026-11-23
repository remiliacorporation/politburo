import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import { board, BoardError, type Board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { createClaimRule, dockMisses, writeRecord, type ClaimsConfig, type Validate } from '../src/index.ts'
import { run } from '../src/claims/cli.ts'
import { defaultConfig } from '../src/config/load.ts'

const channel = 'work/acme-web'
const hold = 4 * 3600
const cooldownMs = 15 * 60_000

function setup(t: TestContext, overrides: Partial<ClaimsConfig> = {}) {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const rules: ReturnType<typeof createClaimRule>[] = []
  const team = board({ backend, claimRule: async (claim) => {
    for (const rule of rules) {
      const refusal = await rule(claim)
      if (refusal) return refusal
    }
  } })
  const red = team.as('red', { can: ['read', 'post', 'label'] })
  const blue = team.as('blue', { can: ['read', 'post', 'label'] })
  const config: ClaimsConfig = { ...defaultConfig().claims, ...overrides }
  const options = (party: string) => ({ board: party === 'red' ? red : blue, party, channel, config, now: () => Date.now() })
  rules.push(createClaimRule(options('red')), createClaimRule(options('blue')))
  const task = async () => (await team.tasks.create(channel, 'Work item')).task.id
  return { team, red, blue, task, options }
}

function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
}

async function holdAttempt(t: TestContext, f: ReturnType<typeof setup>, id: string) {
  const claim = await f.red.tasks.claim(id, { hold, lease: 3600 })
  assert.ok(claim)
  // Keep the short lease alive until the board clamps it to the four-hour end.
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(55 * 60_000)
    await claim.renew(3600)
  }
  return claim
}

test('racing party claims cannot both win with the admission rule installed', async (t) => {
  const f = setup(t)
  const id = await f.task()
  const outcomes = await Promise.allSettled([f.red.tasks.claim(id, { hold }), f.blue.tasks.claim(id, { hold })])
  const wins = outcomes.filter((result) => result.status === 'fulfilled' && result.value !== null)
  assert.equal(wins.length, 1)
  const loser = outcomes.find((result) => result.status === 'rejected')
  assert.equal(loser?.reason.code, 'task_claimed')
})

test('open cap refuses another claim even if the live attempt has an artifact', async (t) => {
  const f = setup(t, { open_claims_per_repo: 1 })
  const task = await f.task()
  const claim = await f.red.tasks.claim(task, { hold })
  assert.ok(claim)
  await writeRecord(f.red, 'artifact', { v: 1, party: 'red', task, epoch: claim.epoch }, { evidence: 'PR 7' })
  const next = await f.task()
  await assert.rejects(f.red.tasks.claim(next, { hold }), { status: 409, code: 'open_claims_per_repo' })
  assert.ok(await f.blue.tasks.claim(next, { hold }))
})

test('open cap refuses claim-next in a parent channel', async (t) => {
  const f = setup(t, { open_claims_per_repo: 1 })
  const first = await f.red.tasks.claim(await f.task(), { hold })
  const { task: next } = await f.red.tasks.create(channel, 'Next work item')
  for (const parent of ['work/', 'work']) {
    await assert.rejects(f.red.tasks.claim({ channel: parent, hold }), { status: 409, code: 'open_claims_per_repo' })
  }
  assert.equal((await f.team.thread(next.id)).message.task?.state, 'ready')
  await first.release()
  assert.equal((await f.red.tasks.claim({ channel: 'work/', hold }))?.task.id, next.id)
})

test('two simultaneous claims by one party for distinct tickets respect open cap one', async (t) => {
  const f = setup(t, { open_claims_per_repo: 1 })
  const first = await f.task(), second = await f.task()
  const outcomes = await Promise.allSettled([f.red.tasks.claim(first, { hold }), f.red.tasks.claim(second, { hold })])
  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1)
  assert.equal(outcomes.find((result) => result.status === 'rejected')?.reason.code, 'open_claims_per_repo')
})

test('uncommitted cap refuses until the claimant links an artifact for the live epoch', async (t) => {
  const f = setup(t)
  const task = await f.task()
  const claim = await f.red.tasks.claim(task, { hold })
  assert.ok(claim)
  const next = await f.task()
  const attempt = { v: 1 as const, party: 'red', task, epoch: claim.epoch }
  const artifact = { evidence: 'PR 7' }
  await f.blue.reply(task, `\`\`\`json\n${JSON.stringify({ ...attempt, kind: 'artifact', ...artifact })}\n\`\`\``)
  await assert.rejects(f.red.tasks.claim(next, { hold }), { status: 409, code: 'uncommitted_claims_per_repo' })
  await writeRecord(f.red, 'artifact', attempt, artifact)
  assert.ok(await f.red.tasks.claim(next, { hold }))
})

test('a hold miss refuses reclaim up to but not including hold end plus fifteen minutes', async (t) => {
  clock(t)
  const f = setup(t)
  const id = await f.task()
  const hardEnd = Date.now() + hold * 1000
  await holdAttempt(t, f, id)
  t.mock.timers.tick(21 * 60_000) // Detect the miss a minute late; detection time must not shift the cooldown.
  await (await f.blue.tasks.claim(id, { hold }))!.release() // Records expiry even if the timer has not run.
  t.mock.timers.tick(hardEnd + cooldownMs - 1 - Date.now())
  await assert.rejects(f.red.tasks.claim(id, { hold }), { status: 409, code: 'reclaim_cooldown' })
  t.mock.timers.tick(1)
  assert.ok(await f.red.tasks.claim(id, { hold }))
})

test('claim by id docks an expired hold before the timer or dock scan runs', async (t) => {
  clock(t)
  const f = setup(t)
  const id = await f.task()
  const claim = await f.red.tasks.claim(id, { hold: 30 })
  const hardEnd = Date.parse(claim.until)
  t.mock.timers.setTime(hardEnd + 1)
  assert.equal((await f.team.poll({ re: id, wait: 0 })).events.some(({ type }) => type === 'task.expired'), false)
  await assert.rejects(f.red.tasks.claim(id, { hold }), {
    status: 409, code: 'reclaim_cooldown', message: `claim cools down until ${new Date(hardEnd + cooldownMs).toISOString()}`,
  })
  await (await f.blue.tasks.claim(id, { hold })).release()
  await dockMisses(f.options('red'))
  assert.equal((await f.team.thread(id)).replies.length, 1)
})

// Use the board-wide IDs of the posts API; local reply() prefixes keys by profile.
function rawReply(handle: Board): Board['reply'] {
  return async (re, input) => {
    const response = await handle.request('/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ re, ...(typeof input === 'string' ? { text: input } : input) })),
    })
    const body = await response.json()
    if (!response.ok) throw new BoardError(body.error.code, body.error.message, response.status)
    return body.message
  }
}

test('a foreign dock id collision does not stop a later miss from being docked', async (t) => {
  clock(t)
  const f = setup(t)
  const first = await f.task(), second = await f.task()
  const actorHash = createHash('sha256').update((await f.red.me()).actor).digest('hex').slice(0, 16)
  for (const id of [first, second]) {
    const { epoch } = await f.red.tasks.claim(id, { hold: 30 })
    const suffix = id === first ? `:${actorHash}` : ''
    await rawReply(f.blue)(id, { id: `swarm-dock:red:${id}:${epoch}${suffix}`, text: 'Foreign record' })
    t.mock.timers.tick(30_000)
    await (await f.blue.tasks.claim(id, { hold })).release()
  }
  await assert.rejects(dockMisses({ ...f.options('red'), board: { ...f.red, reply: rawReply(f.red) } }), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.ok(error.message.includes(first))
    assert.equal(error.errors.length, 1)
    assert.equal(error.errors[0].cause.code, 'duplicate_id')
    return true
  })
  const { replies } = await f.team.thread(second)
  assert.deepEqual(replies.map(({ by }) => by.actor), [(await f.blue.me()).actor, (await f.red.me()).actor])
})

test('repeated dock scans write exactly one correctly attributed dock per expired hold', async (t) => {
  clock(t)
  const f = setup(t, { dock: { missed_claim: 3 } })
  const id = await f.task()
  const hardEnd = Date.now() + hold * 1000
  const claim = await holdAttempt(t, f, id)
  t.mock.timers.tick(20 * 60_000)
  assert.ok(await f.blue.tasks.claim(id, { hold }))
  await dockMisses(f.options('blue'))
  await dockMisses(f.options('red'))
  await dockMisses(f.options('red'))
  const { replies } = await f.team.thread(id)
  assert.equal(replies.length, 1)
  assert.equal(replies[0]?.by.actor, (await f.red.me()).actor)
  assert.deepEqual(JSON.parse(replies[0]!.text.slice(8, -4)), {
    v: 1, kind: 'dock', party: 'red', task: id, epoch: claim.epoch, hardEnd, cooldownUntil: hardEnd + cooldownMs, points: 3,
  })
})

test('an early lease lapse is not a miss even after the original hold end', async (t) => {
  clock(t)
  const f = setup(t)
  const id = await f.task()
  assert.ok(await f.red.tasks.claim(id, { hold, lease: 30 }))
  t.mock.timers.tick(hold * 1000)
  assert.ok(await f.blue.tasks.claim(id, { hold }))
  await dockMisses(f.options('red'))
  assert.deepEqual((await f.team.thread(id)).replies, [])
})

test('completed and review-held attempts get no dock, even after the hold end', async (t) => {
  clock(t)
  const f = setup(t)
  const completed = await f.task(), reviewed = await f.task(), missed = await f.task()
  await (await f.red.tasks.claim(completed, { hold: 30 }))!.complete('Done')
  await (await f.red.tasks.claim(reviewed, { hold: 30 }))!.block('Ready to review', { kind: 'review' })
  assert.ok(await f.red.tasks.claim(missed, { hold: 30 }))
  t.mock.timers.tick(30_000)
  assert.ok(await f.blue.tasks.claim(missed, { hold }))
  await dockMisses(f.options('red'))
  assert.deepEqual((await f.team.thread(completed)).replies, [])
  assert.deepEqual((await f.team.thread(reviewed)).replies, [])
  assert.equal((await f.team.thread(missed)).replies.length, 1)
})

test('only an outcome valid before the hold end suppresses a dock', async (t) => {
  clock(t)
  const f = setup(t)
  const end = Date.now() + 30_000
  const early = await f.task(), late = await f.task()
  for (const id of [early, late]) {
    assert.ok(await f.red.tasks.claim(id, { hold: 30 }))
    t.mock.timers.tick(30_000)
    await (await f.blue.tasks.claim(id, { hold }))!.release()
  }
  const validate: Validate = async ({ task }) => ({ result: 'valid', validAt: task === early ? end - 1 : end + 30_000 })
  await dockMisses({ ...f.options('red'), validate })
  assert.deepEqual((await f.team.thread(early)).replies, [])
  assert.equal((await f.team.thread(late)).replies.length, 1)
})

test('claims status prints the live hard end, not the shorter lease end', async (t) => {
  clock(t)
  const f = setup(t)
  const id = await f.task()
  const claim = await f.red.tasks.claim(id, { hold, lease: 30 })
  assert.ok(claim)
  const log = t.mock.method(console, 'log', () => {})
  assert.equal(await run(['status', '--channel', channel, '--party', 'red', '--json'], () => f.red), 0)
  assert.deepEqual(JSON.parse(log.mock.calls[0]!.arguments[0]), { claims: [{
    task: id, party: 'red', state: 'claimed', epoch: claim.epoch, hardEnd: Date.now() + hold * 1000,
    timeLeftMs: hold * 1000, cooldownUntil: null,
  }] })
})

test('config with downtime pauses is refused when constructing the rule', async (t) => {
  const f = setup(t)
  const options = f.options('red')
  assert.throws(() => createClaimRule({ ...options, config: { ...options.config, pause_on_downtime: true } }), /pause_on_downtime/)
})
