import { expect, it } from 'vitest'
import type { EvidenceStatus } from '../src/contract/evidence.ts'
import { localBoard, personToken } from './harness.ts'
import { useBoard, url, vb } from './cli-harness.ts'
import { serve } from './http.ts'
import { bo, create, failure, ok, task } from './cli-tasks-harness.ts'

const commit = 'a'.repeat(40)
const reviewer = 'vercel:user:u_bo'
useBoard(() => localBoard({ url: undefined, workEvidence: { attesters: { tests: [reviewer] }, operators: [reviewer], resolvers: [reviewer], releaseDependencies: true } }))

it('lists the evidence channel when no task ID follows evidence', async () => {
  const id = await create('evidence', 'Gather evidence')
  await create('other', 'Separate work')
  const { tasks } = JSON.parse(await ok(['tasks', 'evidence', '--json']))
  expect(tasks).toMatchObject([{ message: { id, channel: 'evidence' } }])
})

it('rejects an explicitly empty attestation expiry without recording a verdict', async () => {
  const id = await create('work', 'build the patch', ['--claim', '--json']).then((text) => JSON.parse(text).task.id as string)
  await ok(['tasks', 'submit', id, '--commit', commit, '--artifact', 'builds/1'])
  const ran = await vb(['tasks', 'attest', id, 'tests', 'pass', '--commit', commit, '--round', '1', '--artifact', 'ci/1', '--expires-at', '', '--json'], await bo())
  expect(ran).toMatchObject({ code: 2, stdout: '' })
  expect(failure(ran).message).toContain('--expires-at')
  expect(JSON.parse(await ok(['tasks', 'evidence', id, '--json'])).work.evidence).toEqual([])
})

it('prints each artifact reference and override reason on one terminal line, without changing JSON', async () => {
  const { task, claim } = JSON.parse(await create('work', 'build the patch', ['--claim', '--json']))
  const id = task.id as string
  const artifactRef = 'builds/1\n\u001b[0msecond line'
  const reason = 'CI offline\n\u001b[0mapproved exception'
  const target = ['--commit', commit, '--round', String(claim.epoch)]
  await ok(['tasks', 'submit', id, '--commit', commit, '--artifact', artifactRef])
  await ok(['tasks', 'override', id, 'review', reason, ...target, '--expires-at', new Date(Date.now() + 60_000).toISOString()], await bo())

  const lines = (await ok(['tasks', 'evidence', id])).split('\n')
  expect(lines.filter((line) => /builds\/1|second line/.test(line))).toEqual(['  builds/1␊␛[0msecond line'])
  expect(lines.filter((line) => /CI offline|approved exception/.test(line))).toEqual([`  ${reviewer}: CI offline␊␛[0mapproved exception`])
  const { work } = JSON.parse(await ok(['tasks', 'evidence', id, '--json']))
  expect(work).toMatchObject({ submission: { artifactRef }, overrides: [{ reason }] })
})

it('keeps a board’s evidence error on one detail line and does not print its hint as guidance', async ({ onTestFinished }) => {
  const message = 'evidence unavailable\n\u001b[0msecond line'
  const hint = 'board diagnostic, not CLI guidance'
  const remote = await serve(async () => Response.json({ error: { code: 'stale_candidate', message, hint } }, { status: 409 }))
  onTestFinished(() => remote.close())
  const at = `${remote.origin}/api/board`
  const env = { BOARD_TOKEN: await personToken('u_julian', at) }
  const args = ['tasks', 'evidence', '1', '--url', at]
  const human = await vb(args, env)
  expect(human).toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('Check the current submission and its gates.') })
  expect(human.stderr.split('\n').filter((line) => /evidence unavailable|second line/.test(line))).toEqual(['  evidence unavailable␊␛[0msecond line'])
  expect(human.stderr).not.toContain(hint)
  expect(failure(await vb([...args, '--json'], env))).toMatchObject({ data: { error: { message, hint } } })
})

it('keeps the selected board and profile in the evidence recovery command', async () => {
  const board = ['--url', url, '--as', 'worker']
  const elsewhere = { BOARD_URL: 'http://env.invalid/api/board' }
  const { task } = JSON.parse(await create('work', 'build the patch', ['--claim', '--json', ...board], elsewhere))
  const id = task.id as string
  const args = ['tasks', 'complete', id, ...board]
  const refused = await vb(args, elsewhere)
  expect(refused).toMatchObject({ code: 1, stdout: '' })
  expect(refused.stderr.split('\n')).toContain(`    vb tasks evidence ${id} --url ${url} --as worker`)
  const json = failure(await vb([...args, '--json'], elsewhere))
  expect(json).toMatchObject({ reason: 'evidence_required', next: [{ argv: ['vb', 'tasks', 'evidence', id, ...board] }] })
  expect(await ok(json.next![0]!.argv.slice(1), elsewhere)).toContain('no current submission')
})

it('keeps the selected board and profile when submit has no claim', async () => {
  const board = ['--url', url, '--as', 'worker']
  const elsewhere = { BOARD_URL: 'http://env.invalid/api/board' }
  const id = await create('work', 'Build the patch', board, elsewhere)
  const args = ['tasks', 'submit', id, '--commit', commit, '--artifact', 'builds/1', ...board]
  const argv = ['vb', 'tasks', 'claim', id, ...board]
  const human = await vb(args, elsewhere)
  expect(human).toMatchObject({ code: 1, stdout: '' })
  expect.soft(human.stderr.split('\n')).toContain(`    ${argv.join(' ')}`)
  const json = await vb([...args, '--json'], elsewhere)
  expect(json).toMatchObject({ code: 1, stdout: '' })
  expect(failure(json)).toMatchObject({ reason: 'claim_not_held', next: [{ argv }] })
})

it.each(['submit', 'complete'])('keeps the selected board and profile when %s with a commit loses its claim', async (verb) => {
  const board = ['--url', url, '--as', 'worker']
  const elsewhere = { BOARD_URL: 'http://env.invalid/api/board' }
  for (const json of [false, true]) {
    const { task } = JSON.parse(await create('work', 'Build the patch', ['--claim', '--json', ...board], elsewhere))
    const id = task.id as string
    await ok(['tasks', 'cancel', id, 'superseded', '--url', url], elsewhere)
    const args = ['tasks', verb, id, '--commit', commit, ...(verb === 'submit' ? ['--artifact', 'builds/1'] : []), ...board]
    const ran = await vb([...args, ...(json ? ['--json'] : [])], elsewhere)
    expect(ran).toMatchObject({ code: 1, stdout: '' })
    const read = ['vb', 'read', id, ...board]
    const claim = ['vb', 'tasks', 'claim', id, ...board]
    if (json) expect(failure(ran)).toMatchObject({ reason: 'claim_lost', next: [{ argv: read }, { argv: claim }] })
    else {
      expect.soft(ran.stderr.split('\n')).toContain(`    ${read.join(' ')}`)
      expect.soft(ran.stderr.split('\n')).toContain(`    ${claim.join(' ')}`)
    }
  }
})

it('keeps the selected board and profile when recovery reads a changed task', async () => {
  const need = await create('work', 'build the patch')
  const dependent = await create('work', 'ship the patch', ['--needs', need])
  const { version } = await task(dependent)
  await ok(['tasks', 'priority', dependent, 'high'])

  const board = ['--url', url, '--as', 'resolver']
  const refused = await vb(['tasks', 'resolve', dependent, need, '1', '--if-version', String(version), ...board, '--json'], await bo())
  expect(refused).toMatchObject({ code: 1, stdout: '' })
  expect(failure(refused)).toMatchObject({ reason: 'stale_task', next: [{ argv: ['vb', 'read', dependent, ...board] }] })
})

it('submits and settles a claim, records evidence and an audited override, then explicitly releases the dependent', async () => {
  const need = await create('work', 'build the patch', ['--claim', '--json']).then((text) => JSON.parse(text).task.id as string)
  const dependent = await create('work', 'ship the patch', ['--needs', need])
  const rejected = await vb(['tasks', 'complete', need, '--json'])
  expect(rejected).toMatchObject({ code: 1, stdout: '' })
  expect(failure(rejected)).toMatchObject({ reason: 'evidence_required', next: [{ argv: ['vb', 'tasks', 'evidence', need] }] })
  expect(await ok(['tasks', 'submit', need, '--commit', commit, '--artifact', 'builds/1'])).toBe(`submitted ${need}\n`)
  const check = await bo()
  const target = ['--commit', commit, '--round', '1']
  expect(await ok(['tasks', 'attest', need, 'tests', 'pass', ...target, '--artifact', 'ci/1'], check)).toBe(`attested ${need}\n`)
  expect(await ok(['tasks', 'override', need, 'review', 'approved exception', ...target, '--expires-at', new Date(Date.now() + 60_000).toISOString()], check)).toBe(`overridden ${need}\n`)
  expect(await ok(['tasks', 'complete', need, '--commit', commit])).toBe(`completed ${need}\n`)
  expect((await task(dependent)).task?.state).toBe('waiting')
  const { work } = JSON.parse(await ok(['tasks', 'evidence', need, '--json'])) as { work: EvidenceStatus }
  expect(work).toMatchObject({ submission: { commit }, evidence: [{ gate: 'tests', verdict: 'pass', by: { principal: reviewer } }], overrides: [{ reason: 'approved exception', by: { principal: reviewer } }] })
  const resolved = JSON.parse(await ok(['tasks', 'resolve', dependent, need, work.evidence[0]!.id, '--if-version', String((await task(dependent)).version), '--json'], check))
  expect(resolved).toMatchObject({ task: { id: dependent, task: { state: 'ready' } }, outcome: 'resolved' })
})
