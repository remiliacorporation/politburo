import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { githubAdapter, scanTrackers, type SourceRef } from '../../src/trackers/index.ts'
import { failures, fakeGitHub } from './fake-github.ts'

const source = 'github:o/r'
const ref = (n: number): SourceRef => ({ source, itemId: `I_${n}`, displayId: String(n),
  url: `https://example.invalid/o/r/issues/${n}` })

async function setup(t: TestContext) {
  const { baseUrl, requests } = await fakeGitHub(t)
  const credential = randomUUID()
  const adapter = (sourceId = source, token: () => string | undefined = () => credential) =>
    githubAdapter({ source: sourceId, baseUrl, token })
  return { adapter, baseUrl, credential, requests }
}

test('GitHub scan drops pages, includes PRs, or misreads state or priority', async (t) => {
  const { adapter } = await setup(t)
  const gh = adapter()
  const summarize = (items: Awaited<ReturnType<typeof gh.scan>>['items']) =>
    items.map(({ ref, state, priority }) => [ref.displayId, state, priority])
  const first = await gh.scan()
  assert.equal(first.complete, false)
  assert.ok(first.nextCursor)
  assert.deepEqual(summarize(first.items), [['7', 'done', 'high'], ['8', 'withdrawn', 'none']])
  assert.deepEqual(first.items[0]?.labels, ['P1'])
  assert.deepEqual(first.items[0]?.assignees, ['1', '2'])
  const last = await gh.scan(first.nextCursor)
  assert.equal(last.complete, true)
  assert.equal(last.nextCursor, undefined)
  assert.deepEqual(summarize(last.items), [['9', 'unknown', 'none'], ['7', 'withdrawn', 'low'], ['8', 'done', 'normal']])
})

test('GitHub scan misses next in a Link rel token list or follows an unknown relation', async (t) => {
  const { adapter } = await setup(t)
  for (const repo of ['next-first', 'next-last', 'no-next']) {
    const { nextCursor, complete } = await adapter(`github:o/${repo}`).scan()
    assert.deepEqual([nextCursor, complete], repo === 'no-next' ? [undefined, true] : ['3', false], repo)
  }
})

test('GitHub scan accepts missing or non-array labels or assignees', async (t) => {
  const { adapter } = await setup(t)
  for (const field of ['labels', 'assignees']) {
    for (const invalid of ['missing', 'scalar']) {
      const repo = `${field}-${invalid}`
      await assert.rejects(adapter(`github:o/${repo}`).scan(), { name: 'TrackerError', reason: 'bad_response' }, repo)
    }
  }
})

test('GitHub makes an HTTP request without a credential', async (t) => {
  const { adapter, requests } = await setup(t)
  await assert.rejects(adapter(source, () => undefined).scan(), { name: 'TrackerError', reason: 'no_credential' })
  assert.deepEqual(requests, [])
})

test('GitHub omits the Authorization header or sends the credential elsewhere', async (t) => {
  const { adapter, credential, requests } = await setup(t)
  await adapter().scan()
  assert.ok(requests[0], 'no request received')
  for (const request of requests) {
    assert.ok(request.authorization === `Bearer ${credential}`, 'missing or incorrect Authorization header')
    assert.ok(!request.elsewhere.includes(credential), 'credential sent outside Authorization')
  }
})

test('GitHub exposes a credential or response body on scan errors', async (t) => {
  const { baseUrl, credential } = await setup(t)
  const entry = new URL('../../src/trackers/index.ts', import.meta.url)
  const cases = Object.entries(failures).map(([route, { reason }]) => [route, reason])
  // Capture what the adapter prints as well as every public rendering of its error.
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict'
    import { inspect } from 'node:util'
    import { githubAdapter, TrackerError } from ${JSON.stringify(entry.href)}
    for (const [route, reason] of ${JSON.stringify(cases)}) {
      const gh = githubAdapter({ source: 'github:o/' + route, baseUrl: process.env.TEST_BASE_URL,
        token: () => process.env.TEST_CREDENTIAL })
      await assert.rejects(gh.scan(), error => {
        assert.ok(error instanceof TrackerError)
        assert.equal(error.reason, reason)
        console.log(JSON.stringify([error.message, error.stack, error, inspect(error, { showHidden: true })]))
        return true
      })
    }
  `], { env: { TEST_BASE_URL: baseUrl, TEST_CREDENTIAL: credential }, timeout: 5000 })
  const exposed = stdout + stderr
  assert.ok(!exposed.includes(credential), 'credential leaked on scan error')
  for (const { body, status } of Object.values(failures)) {
    assert.ok(!exposed.includes(body.match(/\d+/)![0]), `response body leaked for ${status}`)
  }
})

test('GitHub get mistakes inaccessible issues for gone, returns PRs, or hides outages and limits', async (t) => {
  const { adapter } = await setup(t)
  const gh = adapter()
  const item = await gh.get(ref(7))
  assert.ok(typeof item !== 'string')
  assert.deepEqual(item.ref, ref(7))
  assert.equal(item.state, 'done')
  assert.equal(await gh.get(ref(11)), 'inaccessible') // ordinary 403
  assert.equal(await gh.get(ref(404)), 'inaccessible') // 404 does not prove deletion
  assert.equal(await gh.get(ref(10)), 'gone') // a confirmed PR is not an issue
  await assert.rejects(gh.get(ref(403)), { name: 'TrackerError', reason: 'rate_limited' })
  await assert.rejects(gh.get(ref(500)), { name: 'TrackerError', reason: 'unavailable' })
})

test('GitHub get returns a different issue at a reused number or the wrong source', async (t) => {
  const { adapter } = await setup(t)
  const gh = adapter()
  const item = await gh.get(ref(7))
  assert.ok(typeof item !== 'string')
  assert.equal(item.ref.source, gh.source)
  assert.equal(await gh.get({ ...ref(7), itemId: 'I_old' }), 'gone')
})

test('scan accepts duplicate source IDs or makes a request before rejecting them', async (t) => {
  const { adapter, requests } = await setup(t)
  const other = 'github:o/2'
  await assert.rejects(scanTrackers({ sources: [adapter(other), adapter(), adapter()].map((adapter) => ({ adapter })),
    precedence: [other, source] }), { name: 'TrackerError', reason: 'bad_source' })
  assert.deepEqual(requests, [])
})

test('a second-page error loses earlier issues, looks complete, or stops another source', async (t) => {
  const { adapter } = await setup(t)
  const broken = 'github:o/2'
  const { items, sources } = await scanTrackers({ sources: [adapter(), adapter(broken)].map((adapter) => ({ adapter })),
    precedence: [broken, source] })
  assert.equal(sources[broken]?.status, 'partial')
  assert.equal(sources[broken]?.reason, 'unavailable')
  assert.equal(sources[source]?.status, 'complete')
  assert.deepEqual(items.map(({ badges, stale }) => [badges[0], stale]),
    [['GH#12', true], ['GH#7', false], ['GH#8', false], ['GH#9', false]])
})

test('maxPages lets later issues through or reports a truncated scan as complete', async (t) => {
  const { adapter } = await setup(t)
  const { items, sources } = await scanTrackers({ sources: [{ adapter: adapter() }], precedence: [source], maxPages: 1 })
  assert.equal(sources[source]?.status, 'partial')
  assert.deepEqual(items.map(({ badges, stale }) => [badges[0], stale]), [['GH#7', true], ['GH#8', true]])
})

test('scan emits repeated observations or keeps an older revision from another page', async (t) => {
  const { adapter } = await setup(t)
  const { items } = await scanTrackers({ sources: [{ adapter: adapter() }], precedence: [source] })
  assert.deepEqual(items.map(({ observations }) => observations.map(({ ref, state, updatedAt }) =>
    [ref.displayId, state, updatedAt])), [
    [['7', 'withdrawn', '2026-01-03T00:00:00Z']],
    [['8', 'withdrawn', '2026-01-02T00:00:00Z']],
    [['9', 'unknown', '2026-01-02T00:00:00Z']],
  ])
})

test('scan dedupe lets input order break ties at equal updatedAt', async (t) => {
  const { adapter } = await setup(t)
  for (const id of ['github:o/tie-forward', 'github:o/tie-reverse']) {
    const { items } = await scanTrackers({ sources: [{ adapter: adapter(id) }], precedence: [id] })
    assert.deepEqual(items.map(({ observations }) => observations.map(({ title }) => title)), [['Z revision']], id)
  }
})
