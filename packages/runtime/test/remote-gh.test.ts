import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ghCodeHost, type GhExec } from '../src/index.ts'
import { branch, shaA, shaB } from './remote-support.ts'

const repo = 'acme/web'
const options = { repo, base: 'main', requiredCheckNames: ['build', 'unit'] }
const draft = { branch, title: 'Fixture', body: '@body stays literal' }
const ok = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value) })
const field = (args: readonly string[], flag: string, value: string) =>
  args.some((arg, i) => arg === flag && args[i + 1] === value)

test('gh creates a draft and reuses it even after closure or a lost create response', async () => {
  let stored: { number: number; draft: boolean; head: { ref: string; repo: { full_name: string } }; state: string } | undefined
  const exec: GhExec = async (args) => {
    const endpoint = args.find((arg) => arg.startsWith(`repos/${repo}/pulls`))!
    assert.ok(endpoint)
    if (args.includes('POST')) {
      assert.equal(endpoint, `repos/${repo}/pulls`)
      assert.equal(stored, undefined)
      assert.ok(field(args, '--field', 'draft=true'))
      assert.ok(field(args, '--raw-field', `head=${draft.branch}`))
      assert.ok(field(args, '--raw-field', `base=${options.base}`))
      assert.ok(field(args, '--raw-field', `title=${draft.title}`))
      assert.ok(field(args, '--raw-field', `body=${draft.body}`))
      stored = { number: 12, draft: true, head: { ref: branch, repo: { full_name: repo } }, state: 'open' }
      return { code: null, stdout: '' } // The host wrote the PR but the CLI lost the reply.
    }
    const query = new URLSearchParams(endpoint.split('?')[1])
    const seen = stored && query.get('head') === `acme:${branch}` && (stored.state === 'open' || query.get('state') === 'all')
    return ok([seen ? [stored] : []])
  }
  const host = ghCodeHost({ ...options, exec })
  assert.equal(await host.openDraftPr(draft), 12)
  assert.equal(stored?.draft, true)
  stored!.state = 'closed'
  const restarted = ghCodeHost({ ...options, exec })
  assert.equal(await restarted.openDraftPr(draft), 12)
})

test('gh checks the exact commit and waits for all named checks across pages', async () => {
  const run = (name: string, status: string, conclusion: string | null, head_sha = shaA) => ({ name, status, conclusion, head_sha })
  const build = run('build', 'completed', 'success')
  const unit = run('unit', 'completed', 'success')
  let runs = [[build]]
  const host = ghCodeHost({ ...options, exec: async (args) => {
    assert.ok(args.some((arg) => arg.startsWith(`repos/${repo}/commits/${shaA}/check-runs?`)))
    const pages = args.includes('--paginate') ? runs : runs.slice(0, 1)
    return ok(pages.map((check_runs) => ({ check_runs })))
  } })
  assert.deepEqual(await host.runChecks(shaA), { sha: shaA, state: 'pending' })
  runs = [[build], [run('unit', 'in_progress', null)]]
  assert.deepEqual(await host.runChecks(shaA), { sha: shaA, state: 'pending' })
  runs = [[build], [run('unit', 'completed', 'failure')]]
  assert.deepEqual(await host.runChecks(shaA), { sha: shaA, state: 'fail' })
  runs = [[build], [unit, run('optional', 'completed', 'failure')]]
  assert.deepEqual(await host.runChecks(shaA), { sha: shaA, state: 'pass' })
  runs = [[build], [run('unit', 'completed', 'success', shaB)]]
  await assert.rejects(host.runChecks(shaA), { name: 'CodeHostError', reason: 'check_sha_mismatch' })
})

test('gh refuses an unfenced ready transition and checks the head inside the fence', async () => {
  let locked = false
  let head = shaA
  let draft = true
  const exec: GhExec = async (args) => {
    if (args.includes(`repos/${repo}/pulls/12`)) return ok({ head: { sha: head } })
    assert.ok(locked, 'the readiness mutation must run within the fence')
    assert.deepEqual(args.slice(0, 3), ['pr', 'ready', '12'])
    assert.ok(field(args, '--repo', `github.com/${repo}`))
    draft = false
    return ok(null)
  }
  assert.equal(await ghCodeHost({ ...options, exec }).markReady(12, shaA), 'readiness_unfenced')
  assert.equal(draft, true)
  const host = ghCodeHost({ ...options, exec, withHeadLock: async (_pr, transition) => {
    head = shaB // A push wins just before the fence is acquired.
    locked = true
    try { return await transition() } finally { locked = false }
  } })
  assert.equal(await host.headSha(12), shaA)
  assert.equal(await host.markReady(12, shaA), 'head_changed')
  assert.equal(draft, true)
  assert.equal(await host.markReady(12, shaB), 'ready')
  assert.equal(draft, false)
})
