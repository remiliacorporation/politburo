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
import { http } from '../../board/src/backend-http/index.ts'
import { BOARD_URL, bearer, localUserToken, testLocal } from '../../board/test/tokens.ts'
import { completeOutcome, reviewOutcome, submitOutcome } from '../src/outcomes/service.ts'
import { registerOutcomeSchemas } from '../src/outcomes/store.ts'

const workId = 'plb-482'
const path = 'report.md'
const worker = 'local:user:worker'
const jockey = 'local:user:jockey'
const cliArgs = ['src/cli.ts', 'outcome', 'complete']
const cliCwd = new URL('../', import.meta.url)

async function seed(t: TestContext, declaredReviewer = 'jockey', fileWorkId = workId) {
  const root = await mkdtemp(join(tmpdir(), 'outcome-service-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({ backend, url: BOARD_URL, authenticate: oidcTokens({ local: testLocal }) })
  const as = async (user: string) => board({ backend: http(BOARD_URL, {
    fetch: bearer((input, init) => team.fetch(new Request(input, init)), await localUserToken(user)),
  }) }).as(null)
  const claimant = await as('worker')
  const reviewer = await as('jockey')
  await registerOutcomeSchemas(team)
  const { task } = await team.tasks.create('work/reports', {
    labels: { 'work.id': workId },
    text: `# Report on queue health

## Acceptable outcomes
<!-- politburo-outcomes:v1 -->
- [ ] kind: report
      location: report.md
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
  await submitOutcome(claimant, {
    taskId: task.id, outcome: { kind: 'report' }, root, party: 'fixture', attempt: '1',
    contractRevision: task.revision, evidence: { work_id: workId, kind: 'report', path, sha256 },
  })
  const thread = () => team.thread(task.id)
  const review = (author = reviewer, decision: 'accept' | 'reject' = 'accept') =>
    reviewOutcome(author, { taskId: task.id, decision, reason: decision === 'reject' ? 'Not sufficient' : '' })
  const complete = (jockeys = [jockey]) => completeOutcome(claimant, {
    taskId: task.id, declaredReviewer, claimant: worker, jockeys, root,
    claim: { epoch: held.epoch, token: held.token },
  })
  async function staysClaimed() {
    assert.equal((await thread()).message.task?.state, 'claimed')
  }
  return { team, task, claimant, reviewer, root, file, sha256, held, review, complete, thread, staysClaimed }
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
    schema: 'outcome-review', version: 1, data: { decision: 'accept', evidence_sha256: run.sha256 },
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

test('the claimant cannot approve their own evidence even as an eligible jockey', async (t) => {
  const run = await seed(t)
  await run.review(run.claimant)
  await run.complete([worker, jockey])
  await run.staysClaimed()
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
  await run.complete()
  await run.staysClaimed()
})

function acceptance(sha256: string) {
  return block('outcome-review@1', {
    work_id: workId, evidence_sha256: sha256, reviewer: null, decision: 'accept', reason: '', at: null,
  })
}

test('editing a board-verified reply into an acceptance does not approve the report', async (t) => {
  const run = await seed(t)
  const reply = await run.reviewer.reply(run.task.id, 'Review pending')
  await run.reviewer.edit(reply.id, acceptance(run.sha256))
  const { replies: [, edited] } = await run.thread()
  assert.ok(edited?.editedAt)
  assert.equal(edited.author?.verified, true)
  assert.equal(edited.blocks[0]?.schema, 'outcome-review')
  await run.complete()
  await run.staysClaimed()
})

test('a posted acceptance from an unverified author does not approve the report', async (t) => {
  const run = await seed(t, 'board:client')
  const reply = await run.team.reply(run.task.id, acceptance(run.sha256))
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
    ...cliArgs, '--task', run.task.id, '--claimant', worker, '--root', run.root, '--json',
  ], {
    cwd: cliCwd, timeout: 5000,
    env: { HOME: run.root, BOARD_URL: `http://127.0.0.1:${address.port}/api/board`, BOARD_TOKEN: await localUserToken('worker') },
  })
  assert.equal(stderr, '')
  assert.deepEqual(JSON.parse(stdout), { complete: true, reasons: [] })
  assert.equal((await run.thread()).message.task?.state, 'completed')
  t.diagnostic(stdout.trim())
})
