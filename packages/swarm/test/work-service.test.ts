import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { block, board, type Board } from '@vercel/board'
import { oidcTokens } from '@vercel/board/access'
import { local } from '@vercel/board/backend-local'
import { http } from '../../board/src/backend-http/index.default.ts'
import { board as boardOverHttp } from '../../board/src/server/index.default.ts'
import { bearer, BOARD_URL, localUserToken, testLocal } from '../../board/test/tokens.ts'
import {
  claimable, createWorkItem, markManualOnly, publishContract, readOutcomes, recordOutcome,
  registerWorkSchemas, type NewWorkItem, type WorkOutcomeRecord,
} from '../src/work/index.ts'

const contract = `## Acceptable outcomes
<!-- politburo-outcomes:v1 -->
- [ ] kind: pull_request
      repo: acme/web
      base: main
      state: open_or_merged
      checks: required_pass
      evidence: url

## Verification
- completion_rule: any_outcome
- on_no_match: release_and_dock`
const input: NewWorkItem = {
  channel: 'work/acme', tag: 'WEB', tags: ['web'], title: 'Fix retries', kind: 'code',
  repo: 'acme/web', description: 'Work on it',
  links: [{ kind: 'issue', source: 'github', scope: 'acme/web', ref: '42', basis: 'explicit' }],
}

async function signedHandle(team: Board, user: string, send: (request: Request) => Promise<Response> = team.fetch) {
  const token = await localUserToken(user)
  return boardOverHttp({ backend: http(BOARD_URL, { fetch: bearer((input, init) => send(new Request(input, init)), token) }) })
}

async function fixture(t: TestContext, options: NonNullable<Parameters<typeof board>[0]>['middleware'] = [], loose = false) {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({
    backend, middleware: options, url: BOARD_URL, authenticate: oidcTokens({ local: testLocal }),
  })
  if (loose) await team.createSchema({ name: 'outcome-record', version: 1, schema: { type: 'object' } })
  else await registerWorkSchemas(team)
  const claimant = (await signedHandle(team, 'claimant')).as(null, { can: ['read', 'label'] })
  return { team, claimant }
}

test('the board refuses a ticket with no valid contract and accepts a claim after valid publication', async (t) => {
  const { team, claimant } = await fixture(t)
  const owner = await signedHandle(team, 'owner')
  const claimantIdentity = await claimant.me()
  assert.notEqual(claimantIdentity.principal, (await owner.me()).principal)
  const { taskId } = await createWorkItem(owner, input)
  await assert.rejects(claimant.tasks.claim(taskId), { code: 'task_blocked' })
  assert.deepEqual(await claimable(claimant, taskId), { claimable: false, reason: 'The outcomes marker must appear exactly once.' })
  assert.deepEqual(await publishContract(owner, taskId, contract), { claimable: true, problems: [] })
  const { task } = await claimant.tasks.claim(taskId)
  assert.equal(task.text, `${input.title}\n\n${contract}`)
  assert.equal(task.task?.claim?.actor, claimantIdentity.actor)
})

test('a fixed work id must replay its reservation without stealing another reservation', async t => {
  const { team } = await fixture(t)
  const reserved = { ...input, id: 'web-42', reservation: 'first-request' }
  const first = await createWorkItem(team, reserved)
  assert.equal(first.workId, 'web-42')
  assert.equal((await createWorkItem(team, reserved)).taskId, first.taskId)
  await assert.rejects(createWorkItem(team, { ...reserved, reservation: 'second-request' }), /already reserved/)
  const { tasks } = await team.tasks.list({ state: 'all', label: ['work.id'] })
  assert.deepEqual(tasks.map(({ message }) => message.id), [first.taskId])
})

test('a claimant at the first publication write cannot take an unvalidated task root', async (t) => {
  let refusedDuringPublication = false
  const { team, claimant } = await fixture(t, [async ({ write, next }) => {
    if (write.kind === 'post' && write.re && write.text.includes('json#work-item@1')) {
      await assert.rejects(claimant.tasks.claim(write.re), { code: 'task_waiting' })
      refusedDuringPublication = true
    }
    await next()
  }])
  await createWorkItem(team, input)
  assert.ok(refusedDuringPublication)
})

test('publishing an invalid revision re-holds a formerly valid ticket before editing it', async (t) => {
  const { team, claimant } = await fixture(t, [async ({ write, next }) => {
    if (write.kind === 'edit') await assert.rejects(claimant.tasks.claim(write.id), { code: 'task_blocked' })
    await next()
  }])
  const { taskId } = await createWorkItem(team, { ...input, description: contract })
  assert.equal((await claimable(team, taskId)).claimable, true)
  assert.equal((await publishContract(team, taskId, 'No proof required')).claimable, false)
  await assert.rejects(claimant.tasks.claim(taskId), { code: 'task_blocked' })
})

test('valid publication does not lift a review hold placed by a different board principal', async (t) => {
  const { team, claimant } = await fixture(t)
  const { taskId } = await createWorkItem(team, { ...input, description: contract })
  const reviewer = await signedHandle(team, 'reviewer')
  await reviewer.tasks.block(taskId, 'Waiting for review', { kind: 'review' })
  assert.equal((await publishContract(team, taskId, contract.replace('main', 'stable'))).claimable, false)
  await assert.rejects(claimant.tasks.claim(taskId), { code: 'task_blocked' })
  assert.equal((await team.thread(taskId)).message.task?.blocked?.kind, 'review')
})

test('valid publication must not lift an outcomes hold placed by another principal', async (t) => {
  const { team, claimant } = await fixture(t)
  const reviewer = await signedHandle(team, 'reviewer')
  const { taskId } = await createWorkItem(team, { ...input, description: contract })
  const before = (await team.thread(taskId)).message.text
  // Even the same kind and reason cannot stand in for the latest hold's author.
  await team.tasks.block(taskId, 'Review required', { kind: 'outcomes' })
  await reviewer.tasks.unblock(taskId)
  await reviewer.tasks.block(taskId, 'Review required', { kind: 'outcomes' })

  assert.deepEqual(await publishContract(team, taskId, contract.replace('main', 'stable')), {
    claimable: false, problems: ['Review required'],
  })
  const { message } = await team.thread(taskId)
  assert.deepEqual(message.task?.blocked, { kind: 'outcomes', reason: 'Review required' })
  assert.equal(message.text, before)
  await assert.rejects(claimant.tasks.claim(taskId), { code: 'task_blocked' })
})

test('publication must not lift a manual_only hold that replaced its outcomes hold before unblock', async (t) => {
  const { team, claimant } = await fixture(t)
  const manager = await signedHandle(team, 'manager')
  const { taskId } = await createWorkItem(team, input)
  const result = await publishContract(team, taskId, contract, async () => {
    await manager.tasks.unblock(taskId)
    await manager.tasks.block(taskId, 'Handle by hand', { kind: 'manual_only' })
  })
  assert.deepEqual(result, { claimable: false, problems: ['Handle by hand'] })
  assert.deepEqual((await team.thread(taskId)).message.task?.blocked, { kind: 'manual_only', reason: 'Handle by hand' })
  await assert.rejects(claimant.tasks.claim(taskId), { code: 'task_blocked' })
})

test('publication reports not claimable and re-holds an owner edit racing the unblock', async (t) => {
  const { team, claimant } = await fixture(t)
  const editor = await signedHandle(team, 'owner')
  for (const description of ['Work on it', contract.replace('main', 'stable')]) {
    const { taskId } = await createWorkItem(editor, input)
    const changed = `${input.title}\n\n${description}`
    const owner = await signedHandle(team, 'owner', async (request) => {
      if (request.method === 'POST' && new URL(request.url).pathname.endsWith(`/tasks/${taskId}/unblock`)) {
        await editor.edit(taskId, changed)
      }
      return team.fetch(request)
    })
    const result = await publishContract(owner, taskId, contract)
    assert.equal(result.claimable, false)
    assert.match(result.problems.join('; '), /text changed during publication/)
    const { message } = await team.thread(taskId)
    assert.equal(message.text, changed)
    assert.equal(message.task?.blocked?.kind, 'outcomes')
    await assert.rejects(claimant.tasks.claim(taskId), { code: 'task_blocked' })
  }
})

test('publication must not replace a foreign hold found during the post-unblock re-read', async (t) => {
  const { team, claimant } = await fixture(t)
  const editor = await signedHandle(team, 'owner')
  const manager = await signedHandle(team, 'manager')
  const { taskId } = await createWorkItem(editor, input)
  const owner = await signedHandle(team, 'owner', async (request) => {
    const response = await team.fetch(request)
    if (response.ok && request.method === 'POST' && new URL(request.url).pathname.endsWith(`/tasks/${taskId}/unblock`)) {
      await editor.edit(taskId, `${input.title}\n\nWork on it`)
      await manager.tasks.block(taskId, 'Handle by hand', { kind: 'manual_only' })
    }
    return response
  })
  const result = await publishContract(owner, taskId, contract)
  assert.equal(result.claimable, false)
  assert.ok(result.problems.includes('Handle by hand'))
  assert.deepEqual((await team.thread(taskId)).message.task?.blocked, { kind: 'manual_only', reason: 'Handle by hand' })
  await assert.rejects(claimant.tasks.claim(taskId), { code: 'task_blocked' })
})

test('valid publication does not release a manual-only ticket', async (t) => {
  const { team, claimant } = await fixture(t)
  const { taskId } = await createWorkItem(team, input)
  await markManualOnly(team, taskId, (await team.me()).actor, 'Handle by hand')
  await publishContract(team, taskId, contract)
  const { message } = await team.thread(taskId)
  assert.equal(message.task?.blocked?.kind, 'manual_only')
  await assert.rejects(claimant.tasks.claim(taskId), { code: 'task_blocked' })
})

test('concurrent same-tag creators cannot both report the same work ID', async (t) => {
  const { team } = await fixture(t)
  const items = await Promise.all([
    createWorkItem(team, input), createWorkItem(team, { ...input, title: 'Fix backoff' }),
  ])
  assert.notEqual(items[0]!.workId, items[1]!.workId)
  assert.notEqual(items[0]!.taskId, items[1]!.taskId)
  for (const { workId, taskId } of items) {
    const page = await team.tasks.list({ label: { 'work.id': workId } })
    assert.deepEqual(page.tasks.map(({ message }) => message.id), [taskId])
    const { replies } = await team.thread(taskId)
    assert.deepEqual(replies[0]?.blocks[0]?.data, {
      work_id: workId, repo: input.repo, kind: input.kind, links: input.links, contract_revision: null,
    })
  }
})

const sample: WorkOutcomeRecord = {
  work_id: 'web-1', party: 'party-a', attempt: 2, contract_revision: '42',
  outcome: { kind: 'pull_request', index: 0 }, result: 'valid',
  evidence: { ref: 'https://github.com/acme/web/pull/42', revision: 'abc123' },
  checked_at: '2026-01-03T12:00:00.000Z', verifier_version: '1', override: null,
}

test('outcome replies round trip once in thread order and opt out of sync', async (t) => {
  const { team } = await fixture(t)
  const { task } = await team.tasks.create(input.channel, 'Fix retries')
  const second = { ...sample, checked_at: '2026-01-03T12:01:00.000Z' }
  await recordOutcome(team, task.id, sample)
  await recordOutcome(team, task.id, sample)
  await recordOutcome(team, task.id, second)
  assert.deepEqual(await readOutcomes(team, task.id), [sample, second])
  assert.ok((await team.thread(task.id)).replies.every(reply => reply.noSync))
})

test('distinct outcome bodies at the same timestamp must not collapse, but a reordered replay must', async (t) => {
  const { team } = await fixture(t)
  const { task } = await team.tasks.create(input.channel, 'Fix retries')
  const second = { ...sample, evidence: { ref: sample.evidence!.ref, revision: 'def456' } }
  const { evidence, ...rest } = second
  await recordOutcome(team, task.id, sample)
  await recordOutcome(team, task.id, second)
  await recordOutcome(team, task.id, { evidence: { revision: evidence.revision, ref: evidence.ref }, ...rest })
  assert.deepEqual(await readOutcomes(team, task.id), [sample, second])
})

test('recordOutcome refuses to write an override impersonating another actor', async (t) => {
  const { team } = await fixture(t)
  const { task } = await team.tasks.create(input.channel, 'Fix retries')
  await assert.rejects(recordOutcome(team, task.id, { ...sample, override: { actor: 'jockey', reason: 'Approved' } }), /actor must match/)
  assert.deepEqual((await team.thread(task.id)).replies, [])
})

test('readOutcomes drops an override that disagrees with its board-verified reply author', async (t) => {
  const { team } = await fixture(t)
  const { task } = await team.tasks.create(input.channel, 'Fix retries')
  const verified = { ...sample, override: { actor: (await team.me()).actor, reason: 'Approved' } }
  await recordOutcome(team, task.id, verified)
  await team.reply(task.id, block('outcome-record@1', { ...sample, override: { actor: 'jockey', reason: 'Approved' } }))
  assert.deepEqual(await readOutcomes(team, task.id), [verified])
})

test('outcome data cannot assert provenance for a reply by another actor', async (t) => {
  const { team } = await fixture(t)
  const { task } = await team.tasks.create(input.channel, 'Fix retries')
  const author = (await team.me()).actor
  await recordOutcome(team, task.id, sample)
  await team.as('other-dispatcher').reply(task.id, block('outcome-record@1', {
    ...sample, override: { actor: author, reason: 'Approved' },
  }))
  assert.deepEqual(await readOutcomes(team, task.id), [sample])
})

test('a loose board registration cannot make a malformed outcome readable', async (t) => {
  const { team } = await fixture(t, [], true)
  const { task } = await team.tasks.create(input.channel, 'Fix retries')
  await team.reply(task.id, block('outcome-record@1', { ...sample, evidence: { ref: 'missing revision' } }))
  assert.deepEqual(await readOutcomes(team, task.id), [])
})

test('an override with a whitespace-only reason is not written', async (t) => {
  const { team } = await fixture(t)
  const { task } = await team.tasks.create(input.channel, 'Fix retries')
  await assert.rejects(recordOutcome(team, task.id, { ...sample, override: { actor: 'jockey', reason: '   ' } }), /non-empty reason/)
  assert.deepEqual((await team.thread(task.id)).replies, [])
})
