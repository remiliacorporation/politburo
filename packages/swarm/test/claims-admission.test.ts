import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { board, type Board, type Middleware } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { createClaims, type ClaimsConfig } from '../src/claims/service.ts'
import { defaultConfig } from '../src/config/load.ts'

const channel = 'work/acme-web'

function setup(t: TestContext, caps: Partial<ClaimsConfig> = {}, middleware: Middleware[] = []) {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({ backend, middleware })
  const config: ClaimsConfig = { ...defaultConfig().claims, ...caps }
  const service = (party: string) => createClaims({
    board: team.as(party, { can: ['read', 'post', 'label'] }), channel, party, config,
  })
  const tasks = async (count: number) => {
    const ids: string[] = []
    for (let i = 0; i < count; i++) ids.push((await team.tasks.create(channel, `Work ${i + 1}`)).task.id)
    return ids
  }
  return { team, service, tasks }
}

function dock(author: Board, task: string, party: string, cooldownUntil = Date.now() + 60_000) {
  const data = { v: 1, kind: 'dock', task, party, epoch: 1, hardEnd: Date.now(), points: 1, cooldownUntil }
  return author.reply(task, {
    text: `\`\`\`json\n${JSON.stringify(data)}\n\`\`\``,
    labels: { 'swarm.kind': 'dock', 'swarm.party': party, 'swarm.epoch': '1' },
  })
}

async function chatter(team: Board, task: string, count: number) {
  for (let i = 0; i < count; i++) await team.reply(task, `Reply ${i + 1}`)
}

test('racing parties cannot both win or throw instead of returning task_claimed', async (t) => {
  const { service, tasks } = setup(t)
  const [task] = await tasks(1)
  const results = await Promise.all([service('red').claim(task!), service('blue').claim(task!)])
  assert.equal(results.filter(({ ok }) => ok).length, 1)
  assert.deepEqual(results.find(({ ok }) => !ok), { ok: false, code: 'task_claimed' })
})

test('concurrent claims by one service cannot overrun its open cap of one', async (t) => {
  const { service, tasks } = setup(t, { open_claims_per_repo: 1 })
  const [first, second] = await tasks(2)
  const red = service('red')
  const results = await Promise.all([red.claim(first!), red.claim(second!)])
  const wins = results.filter((result) => result.ok)
  assert.equal(wins.length, 1)
  assert.deepEqual(results.find(({ ok }) => !ok), {
    ok: false, code: 'open_claims_per_repo', retryAt: wins[0]!.hardEnd,
  })
})

test('a third open claim must name the open cap and the earliest hard end', async (t) => {
  const { service, tasks } = setup(t, { uncommitted_claims_per_repo: 3 })
  const [first, second, third] = await tasks(3)
  const red = service('red')
  const earlier = await red.claim(first!)
  assert.ok(earlier.ok)
  while (Date.now() <= earlier.claimedAt) await new Promise((resolve) => setTimeout(resolve, 1))
  const later = await red.claim(second!)
  assert.ok(later.ok && later.hardEnd > earlier.hardEnd)
  assert.deepEqual(await red.claim(third!), {
    ok: false, code: 'open_claims_per_repo', retryAt: earlier.hardEnd,
  })
})

test('invalid evidence must not lift the uncommitted cap; valid evidence must lift it', async (t) => {
  const { service, tasks } = setup(t)
  const [first, second] = await tasks(2)
  const red = service('red')
  const claim = await red.claim(first!)
  assert.ok(claim.ok)
  assert.deepEqual(await red.claim(second!), {
    ok: false, code: 'uncommitted_claims_per_repo', retryAt: claim.hardEnd,
  })
  for (const evidence of ['', '   ', 'x'.repeat(2049), 'first\u0000attempt']) {
    await assert.rejects(red.attach(first!, evidence), /claim evidence/)
    assert.deepEqual(await red.claim(second!), {
      ok: false, code: 'uncommitted_claims_per_repo', retryAt: claim.hardEnd,
    })
  }
  await red.attach(first!, 'Evidence from the first attempt')
  assert.ok((await red.claim(second!)).ok)
})

test('another party or repo must not consume this party and repo’s open cap', async (t) => {
  const { team, service, tasks } = setup(t, { open_claims_per_repo: 1 })
  const [foreign, own] = await tasks(2)
  const red = team.as('red', { can: ['read', 'post', 'label'] })
  const { task } = await team.tasks.create('work/other-repo', 'Elsewhere')
  await red.tasks.claim(task.id)
  assert.ok((await service('blue').claim(foreign!)).ok)
  assert.ok((await service('red').claim(own!)).ok)
})

test('status must not omit a live claim or show it to the wrong party', async (t) => {
  const { service, tasks } = setup(t)
  const [task] = await tasks(1)
  const red = service('red')
  const claim = await red.claim(task!)
  assert.ok(claim.ok)
  const [row, ...rest] = await red.status()
  assert.deepEqual(rest, [])
  assert.ok(row?.state === 'claimed')
  assert.equal(row.task, task)
  assert.equal(row.party, 'red')
  assert.equal(row.hardEnd, claim.hardEnd)
  assert.ok(row.timeLeftMs > 0 && row.timeLeftMs <= 4 * 3_600_000)
  assert.equal(row.cooldownUntil, null)
  assert.deepEqual(await service('blue').status(), [])
})

test('reclaim must find docks on both the oldest and continuation pages', async (t) => {
  const { team, service, tasks } = setup(t)
  const [task] = await tasks(1)
  const retryAt = Date.now() + 60_000
  await dock(team.as('red'), task!, 'red', retryAt)
  await chatter(team, task!, 499)
  await dock(team.as('blue'), task!, 'blue', retryAt)
  await chatter(team, task!, 2)
  for (const party of ['red', 'blue']) {
    assert.deepEqual(await service(party).claim(task!), { ok: false, code: 'reclaim_cooldown', retryAt })
  }
})

test('oversized task history must fail closed for claim, attach and status', async (t) => {
  const { team, service, tasks } = setup(t)
  const [task] = await tasks(1)
  await dock(team.as('red'), task!, 'red')
  await chatter(team, task!, 2000)
  const red = service('red')
  const namesTask = new RegExp(`task ${task}:`)
  assert.deepEqual(await red.claim(task!), { ok: false, code: 'history_too_long' })
  await assert.rejects(red.attach(task!, 'Evidence'), namesTask)
  await assert.rejects(red.status(), namesTask)
})

test('status skips oversized stale or unindexed history but reports recent docks', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  const { team, service, tasks } = setup(t, { reclaim_cooldown_minutes: 2 })
  const [old, recent] = await tasks(2)
  const stale = await dock(team.as('red'), old!, 'red')
  await chatter(team, old!, 2000)
  t.mock.timers.tick(2 * 60_000 + 1)
  const retryAt = Date.now() + 60_000
  await dock(team.as('red'), recent!, 'red', retryAt)
  const red = service('red')
  const expected = [{ task: recent, party: 'red', state: 'cooling', cooldownUntil: retryAt }]
  assert.deepEqual(await red.status(), expected)
  await team.label(stale.id, { unset: ['swarm.kind'] })
  await team.reply(old!, 'New activity, but no indexed dock or open claim')
  assert.deepEqual(await red.status(), expected)
})

test('reclaim still honors a dock after another actor strips its index labels', async (t) => {
  const { team, service, tasks } = setup(t)
  const [task] = await tasks(1)
  const retryAt = Date.now() + 60_000
  const record = await dock(team.as('red'), task!, 'red', retryAt)
  await team.as('blue', { can: ['read', 'label'] }).label(record.id, {
    unset: ['swarm.kind', 'swarm.party', 'swarm.epoch'],
  })
  assert.deepEqual(await service('red').claim(task!), { ok: false, code: 'reclaim_cooldown', retryAt })
})

test('the same service can reclaim after its board lease lapses', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  const { service, tasks } = setup(t)
  const [task] = await tasks(1)
  const red = service('red')
  const first = await red.claim(task!)
  assert.ok(first.ok)
  t.mock.timers.tick(60_001)
  const second = await red.claim(task!)
  assert.ok(second.ok && second.epoch > first.epoch)
})

test('a dropped claim record must surface the error and leave the task claimable', async (t) => {
  const { service, tasks } = setup(t, {}, [({ write, source, next }) => {
    if (write.kind === 'post' && write.re && source.kind === 'client' && source.name === 'red') return
    return next()
  }])
  const [task] = await tasks(1)
  await assert.rejects(service('red').claim(task!), { code: 'dropped' })
  assert.ok((await service('blue').claim(task!)).ok)
})

test('status ignores a dock authored by a different actor for the requested party', async (t) => {
  const { team, service, tasks } = setup(t)
  const [task] = await tasks(1)
  await dock(team.as('blue'), task!, 'red')
  assert.deepEqual(await service('red').status(), [])
})
