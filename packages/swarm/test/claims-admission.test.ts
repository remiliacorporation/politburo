import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { createClaims, type ClaimsConfig } from '../src/claims/service.ts'
import { defaultConfig } from '../src/config/load.ts'

const channel = 'work/acme-web'

function setup(t: TestContext, caps: Partial<ClaimsConfig> = {}) {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({ backend })
  const config: ClaimsConfig = { ...defaultConfig().claims, ...caps }
  const service = (party: string) => createClaims({
    board: team.as(party, { can: ['read', 'post', 'label'] }), channel, party, config,
    validate: async () => ({ result: 'invalid' }),
  })
  const tasks = async (count: number) => {
    const ids: string[] = []
    for (let i = 0; i < count; i++) ids.push((await team.tasks.create(channel, `Work ${i + 1}`)).task.id)
    return ids
  }
  return { team, service, tasks }
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

test('an uncommitted claim must consume its cap until attach commits it', async (t) => {
  const { service, tasks } = setup(t)
  const [first, second] = await tasks(2)
  const red = service('red')
  const claim = await red.claim(first!)
  assert.ok(claim.ok)
  assert.deepEqual(await red.claim(second!), {
    ok: false, code: 'uncommitted_claims_per_repo', retryAt: claim.hardEnd,
  })
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
