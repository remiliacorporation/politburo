import { expect, it } from 'vitest'
import type { EvidenceStatus } from '../src/contract/evidence.ts'
import { localBoard } from './harness.ts'
import { useBoard, vb } from './cli-harness.ts'
import { bo, create, failure, ok, task } from './cli-tasks-harness.ts'

const commit = 'a'.repeat(40)
const reviewer = 'vercel:user:u_bo'
useBoard(() => localBoard({ url: undefined, workEvidence: { attesters: { tests: [reviewer] }, operators: [reviewer], resolvers: [reviewer], releaseDependencies: true } }))

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
