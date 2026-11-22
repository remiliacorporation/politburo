import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { block, board } from '@vercel/board'
import { oidcTokens } from '@vercel/board/access'
import { local } from '@vercel/board/backend-local'
import { BOARD_URL, localUserToken, testLocal } from '../../board/test/tokens.ts'
import { completeOutcome, reviewOutcome, submitOutcome } from '../src/outcomes/service.ts'
import { registerOutcomeSchemas } from '../src/outcomes/store.ts'

const workId = 'plb-482'
const path = 'report.md'
const worker = 'local:user:worker'
const validator = `${worker}+validator`
const jockey = `${worker}+jockey`
const party = 'fixture', attempt = '1'
const cliArgs = ['src/cli.ts', 'outcome', 'complete']
const cliCwd = new URL('../', import.meta.url)

async function seed(t: TestContext, declaredReviewer = 'jockey', fileWorkId = workId, location = `location: ${path}`) {
  const root = await mkdtemp(join(tmpdir(), 'outcome-service-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({ backend, url: BOARD_URL, authenticate: oidcTokens({ local: testLocal }) })
  const previousUrl = process.env.BOARD_URL, previousToken = process.env.BOARD_TOKEN
  t.after(() => {
    if (previousUrl === undefined) delete process.env.BOARD_URL
    else process.env.BOARD_URL = previousUrl
    if (previousToken === undefined) delete process.env.BOARD_TOKEN
    else process.env.BOARD_TOKEN = previousToken
  })
  process.env.BOARD_URL = BOARD_URL
  process.env.BOARD_TOKEN = await localUserToken('worker')
  let fail: 'claim' | 'complete' | undefined
  t.mock.method(globalThis, 'fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    assert.ok(request.url.startsWith(`${BOARD_URL}/`) || request.url === BOARD_URL)
    if (fail && request.method === 'POST' && new URL(request.url).pathname.endsWith(`/${fail}`)) {
      return Promise.resolve(Response.json({ error: { code: 'test_failure', message: `refused ${fail}` } }, { status: 409 }))
    }
    return team.fetch(request)
  })
  const remote = board()
  const claimant = remote.as(null)
  const submitter = remote.as('validator')
  const reviewer = remote.as('jockey')
  await registerOutcomeSchemas(team)
  const { task } = await claimant.tasks.create('work/reports', {
    labels: { 'work.id': workId },
    text: `# Report on queue health

## Acceptable outcomes
<!-- politburo-outcomes:v1 -->
- [ ] kind: report
      ${location}
      required_sections: [findings, recommendation]

## Verification
- completion_rule: any_outcome
- reviewer: ${declaredReviewer}
`,
  })
  const file = join(root, path)
  const text = `---\nwork_id: ${fileWorkId}\n---\n## Findings\nThe queue drained.\n\n## Recommendation\nKeep the current limits.\n`
  await writeFile(file, text)
  const sha256 = createHash('sha256').update(text).digest('hex')
  const held = await claimant.tasks.claim(task.id)
  const submit = (poster = submitter, overrides: { party?: string; attempt?: string } = {}) => submitOutcome(poster, {
    taskId: task.id, outcome: { kind: 'report' }, root, party, attempt,
    contractRevision: task.revision, evidence: { work_id: workId, kind: 'report', path, sha256 }, ...overrides,
  })
  if (location) await submit()
  const thread = () => team.thread(task.id)
  const review = (author = reviewer, decision: 'accept' | 'reject' = 'accept') =>
    reviewOutcome(author, { taskId: task.id, decision, reason: decision === 'reject' ? 'Not sufficient' : '' })
  const complete = (overrides: Partial<Parameters<typeof completeOutcome>[1]> = {}) => completeOutcome(claimant, {
    taskId: task.id, declaredReviewer, jockeys: [jockey], validators: [validator], root, party, attempt,
    claim: { epoch: held.epoch, token: held.token }, ...overrides,
  })
  async function staysClaimed() {
    assert.equal((await thread()).message.task?.state, 'claimed')
  }
  return { team, task, claimant, submitter, reviewer, root, file, sha256, held, submit, review, complete, thread, staysClaimed,
    refuse: (action: typeof fail) => { fail = action },
  }
}

test('a seeded report ticket completes with a file as proof and no PR', async (t) => {
  const run = await seed(t)
  const { replies: [submission] } = await run.thread()
  const [record] = submission!.blocks
  assert.equal(`${record?.schema}@${record?.version}`, 'outcome-record@1')
  assert.partialDeepStrictEqual(record?.data, {
    work_id: workId, result: 'valid', outcome: { kind: 'report', index: 0 },
    evidence: { path, sha256: run.sha256 },
  })

  await run.review()
  const { message: claimed, replies: [, approval] } = await run.thread()
  assert.equal(claimed.task?.claim?.actor, worker)
  assert.equal(approval?.by.actor, jockey)
  assert.equal(approval?.author?.verified, true)
  assert.partialDeepStrictEqual(approval?.blocks[0], {
    schema: 'outcome-review', version: 1, data: { record: submission!.id, decision: 'accept', evidence_sha256: run.sha256 },
  })

  await run.complete()
  const { message, replies } = await run.thread()
  assert.equal(message.task?.state, 'completed')
  assert.equal(message.task?.result, `outcome evidence sha256 ${run.sha256}`)
  assert.deepEqual([message, ...replies].flatMap((entry) => entry.links), [])
  assert.deepEqual(await readdir(run.root), [path])
  t.diagnostic(`outcome-record@1 ${workId}: valid ${path}`)
  t.diagnostic(`outcome-review@1 ${approval.by.actor}: accept (verified)`)
  t.diagnostic(`task ${message.task.state}: ${message.task.result}; no PR links or Git repository`)
})

test('a valid submission without a review leaves the task claimed', async (t) => {
  const run = await seed(t)
  await run.complete()
  await run.staysClaimed()
})

test('editing the evidence after acceptance leaves the task claimed', async (t) => {
  const run = await seed(t)
  await run.review()
  await appendFile(run.file, '\nUpdated recommendation.\n')
  await run.complete()
  await run.staysClaimed()
})

test('a report whose front matter names another work id is recorded as invalid', async (t) => {
  const run = await seed(t, 'jockey', 'plb-999')
  const { replies: [submission] } = await run.thread()
  assert.partialDeepStrictEqual(submission?.blocks[0]?.data, { result: 'invalid', outcome: null })
  await run.complete()
  await run.staysClaimed()
})

test('the record author cannot approve their own evidence even as an eligible jockey', async (t) => {
  const run = await seed(t)
  const approval = await run.review(run.submitter)
  assert.equal(approval.reviewer, validator)
  assert.equal((await run.thread()).message.task?.claim?.actor, worker)
  assert.deepEqual(await run.complete({ jockeys: [validator, jockey] }), {
    complete: false, reasons: ['latest reviewer is not allowed'],
  })
  await run.staysClaimed()
})

test('an unverified or unlisted validator record cannot complete the task', async (t) => {
  const run = await seed(t)
  await run.submit(run.claimant)
  await run.review()
  assert.equal((await run.complete()).complete, false)
  await run.staysClaimed()

  const { replies: [submission] } = await run.thread()
  const unverified = await run.team.reply(run.task.id, block('outcome-record@1', submission!.blocks[0]!.data))
  assert.notEqual(unverified.author?.verified, true)
  await run.reviewer.reply(run.task.id, acceptance(unverified.id, run.sha256))
  assert.equal((await run.complete({ validators: [unverified.by.actor] })).complete, false)
  await run.staysClaimed()
})

test('a review naming an older submission cannot approve a resubmission of the same bytes', async (t) => {
  const run = await seed(t)
  const approval = await run.review()
  await run.submit()
  assert.equal((await run.complete()).complete, false)
  // Even a review posted after the new submission must name that exact record.
  await run.reviewer.reply(run.task.id, acceptance(approval.record, run.sha256))
  assert.equal((await run.complete()).complete, false)
  const { replies } = await run.thread()
  const submission = replies.filter((reply) => reply.blocks[0]?.schema === 'outcome-record').at(-1)!
  await run.reviewer.reply(run.task.id, acceptance(submission.id, '0'.repeat(64)))
  assert.equal((await run.complete()).complete, false)
  await run.staysClaimed()
  const latest = await run.review()
  assert.equal(latest.record, submission.id)
  assert.equal((await run.complete()).complete, true)
})

test('a newer record for a different party or attempt cannot complete the requested attempt', async (t) => {
  const run = await seed(t)
  await run.review()
  for (const overrides of [{ party: 'other' }, { attempt: '2' }]) {
    await run.submit(run.submitter, overrides)
    await run.review()
    assert.deepEqual(await run.complete(), { complete: false, reasons: ['outcome does not match party and attempt'] })
    await run.staysClaimed()
  }
})

test('a report without a declared location cannot complete even with valid evidence and a review', async (t) => {
  const run = await seed(t, 'jockey', workId, '')
  const record = await run.submitter.reply(run.task.id, block('outcome-record@1', {
    work_id: workId, party, attempt, contract_revision: run.task.revision,
    result: 'valid', outcome: { kind: 'report', index: 0 }, evidence: { path, sha256: run.sha256 },
    checked_at: null, verifier_version: '1', override: null,
  }))
  await run.reviewer.reply(run.task.id, acceptance(record.id, run.sha256))
  assert.deepEqual(await run.complete(), { complete: false, reasons: ['declared report outcome requires a location'] })
  await run.staysClaimed()
})

test('claim and completion failures do not lose a review hold or release a supplied claim', async (t) => {
  const run = await seed(t)
  await run.review()
  run.refuse('complete')
  await assert.rejects(run.complete(), /refused complete/)
  await run.staysClaimed()

  const hold = { kind: 'review', reason: 'Awaiting review' }
  await run.held.block(hold.reason, { kind: hold.kind })
  for (const action of ['claim', 'complete'] as const) {
    run.refuse(action)
    await assert.rejects(run.complete({ claim: undefined }), new RegExp(`refused ${action}`))
    const { message } = await run.thread()
    assert.equal(message.task?.state, 'blocked')
    assert.deepEqual(message.task?.blocked, hold)
  }
})

test('a verified jockey cannot stand in for a different named reviewer', async (t) => {
  const run = await seed(t, 'local:user:auditor')
  await run.review()
  await run.complete()
  await run.staysClaimed()
})

test('a verified rejection leaves the task claimed', async (t) => {
  const run = await seed(t)
  await run.review(run.reviewer, 'reject')
  const { replies: [submission, rejection] } = await run.thread()
  assert.equal(rejection?.by.actor, jockey)
  assert.partialDeepStrictEqual(rejection?.blocks[0], {
    schema: 'outcome-review', version: 1,
    data: { record: submission!.id, decision: 'reject', reason: 'Not sufficient', evidence_sha256: run.sha256 },
  })
  assert.deepEqual(await run.complete(), { complete: false, reasons: ['latest review rejected the evidence'] })
  await run.staysClaimed()
})

function acceptance(record: string, sha256: string) {
  return block('outcome-review@1', {
    work_id: workId, record, evidence_sha256: sha256, reviewer: null, decision: 'accept', reason: '', at: null,
  })
}

test('editing a board-verified reply into an acceptance does not approve the report', async (t) => {
  const run = await seed(t)
  const reply = await run.reviewer.reply(run.task.id, 'Review pending')
  const { replies: [submission] } = await run.thread()
  await run.reviewer.edit(reply.id, acceptance(submission!.id, run.sha256))
  const { replies: [, edited] } = await run.thread()
  assert.ok(edited?.editedAt)
  assert.equal(edited.author?.verified, true)
  assert.equal(edited.blocks[0]?.schema, 'outcome-review')
  await run.complete()
  await run.staysClaimed()
})

test('a posted acceptance from an unverified author does not approve the report', async (t) => {
  const run = await seed(t, 'board:client')
  const { replies: [submission] } = await run.thread()
  const reply = await run.team.reply(run.task.id, acceptance(submission!.id, run.sha256))
  assert.equal(reply.by.actor, 'board:client')
  assert.notEqual(reply.author?.verified, true)
  assert.equal(reply.blocks[0]?.schema, 'outcome-review')
  await run.complete()
  await run.staysClaimed()
})

test('swarm outcome complete reports bad flags on stderr and exits 2', () => {
  const result = spawnSync(process.execPath, [...cliArgs, '--bogus'], { cwd: cliCwd, env: {}, encoding: 'utf8' })
  if (result.error) throw result.error
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^error: invalid outcome flags\n$/)
})

test('swarm outcome complete --json exits successfully with one JSON document', async (t) => {
  const run = await seed(t, jockey)
  await run.review()
  await run.held.release()
  // Expose the same in-memory board to the subprocess, only on loopback.
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const response = await run.team.fetch(new Request(`${BOARD_URL}${req.url!.slice('/api/board'.length)}`, {
        method: req.method, headers: new Headers(req.headers as Record<string, string>),
        body: chunks.length ? Buffer.concat(chunks).toString('utf8') : null,
      }))
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch {
      res.writeHead(500).end()
    }
  })
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    ...cliArgs, '--task', run.task.id, '--validators', validator, '--party', party, '--attempt', attempt, '--root', run.root, '--json',
  ], {
    cwd: cliCwd, timeout: 5000,
    env: { HOME: run.root, BOARD_URL: `http://127.0.0.1:${address.port}/api/board`, BOARD_TOKEN: await localUserToken('worker') },
  })
  assert.equal(stderr, '')
  assert.deepEqual(JSON.parse(stdout), { complete: true, reasons: [] })
  assert.equal((await run.thread()).message.task?.state, 'completed')
  t.diagnostic(stdout.trim())
})
