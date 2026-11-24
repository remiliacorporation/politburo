import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { inspect } from 'node:util'
import { linearAdapter, scanTrackers, TrackerError } from '../../src/trackers/index.ts'
import { fakeLinear, linearIssue } from './fake-linear.ts'

const source = 'linear:KEY'
const credential = 'dummy-linear-adapter-key'
async function setup(t: TestContext, options?: Parameters<typeof fakeLinear>[1]) {
  const { baseUrl } = await fakeLinear(t, options)
  return linearAdapter({ source, baseUrl, token: () => credential })
}

test('Linear scan drops or overruns pages, or misreads state, priority, labels, or assignee', async (t) => {
  const adapter = await setup(t)
  const first = await adapter.scan()
  assert.deepEqual([first.complete, first.nextCursor], [false, '2'])
  const second = await adapter.scan(first.nextCursor)
  assert.deepEqual([second.complete, second.nextCursor], [false, '3'])
  const last = await adapter.scan(second.nextCursor)
  assert.deepEqual([last.complete, last.nextCursor], [true, undefined])
  assert.deepEqual([first, second, last].flatMap(({ items }) => items.map(({ ref, state, priority }) =>
    [ref.displayId, state, priority])), [
    ['KEY-7', 'open', 'urgent'], ['KEY-8', 'open', 'high'], ['KEY-9', 'open', 'normal'],
    ['KEY-10', 'open', 'low'], ['KEY-11', 'done', 'none'], ['KEY-12', 'withdrawn', 'none'], ['KEY-13', 'unknown', 'none'],
  ])
  assert.deepEqual(first.items[0]?.labels, ['work:plb-1'])
  assert.deepEqual(first.items[0]?.assignees, ['1'])
  assert.deepEqual(first.items[1]?.assignees, [])
  const scanned = await scanTrackers({ sources: [{ adapter }], precedence: [source] })
  assert.deepEqual(scanned.sources[source], { status: 'complete', pages: 3 })
  assert.deepEqual(scanned.items.map(({ badges }) => badges[0]).sort(),
    ['LIN KEY-10', 'LIN KEY-11', 'LIN KEY-12', 'LIN KEY-13', 'LIN KEY-7', 'LIN KEY-8', 'LIN KEY-9'])
})

test('Linear get rejects a matching issue or treats a null or mismatched issue as present', async (t) => {
  const adapter = await setup(t)
  const ref = (n: number) => {
    const { id, identifier, url } = linearIssue(n, 'triage', 1)
    return { source, itemId: id, displayId: identifier, url }
  }
  const found = await adapter.get(ref(7))
  assert.ok(typeof found !== 'string')
  assert.deepEqual(found.ref, ref(7))
  assert.equal(await adapter.get(ref(404)), 'gone', 'null issue')
  assert.equal(await adapter.get(ref(8)), 'gone', 'mismatched id')
})

test('Linear scan and get accept truncated labels or invalid label pagination', async (t) => {
  const issue = linearIssue(7, 'triage', 1, ['work:plb-1'])
  const ref = { source, itemId: issue.id, displayId: issue.identifier, url: issue.url }
  const valid = await setup(t, { singleIssue: issue })
  assert.deepEqual((await valid.scan()).items[0]?.labels, ['work:plb-1'])
  const found = await valid.get(ref)
  assert.ok(typeof found !== 'string')
  assert.deepEqual(found.labels, ['work:plb-1'])

  for (const [name, pageInfo] of [['truncated', { hasNextPage: true }], ['missing', undefined],
    ['malformed', { hasNextPage: 'false' }]] as const) {
    const adapter = await setup(t, { singleIssue: { ...issue, labels: { ...issue.labels, pageInfo } } })
    await assert.rejects(adapter.scan(), { name: 'TrackerError', reason: 'bad_response' }, `scan: ${name}`)
    await assert.rejects(adapter.get(ref), { name: 'TrackerError', reason: 'bad_response' }, `get: ${name}`)
  }
})

test('Linear get and scan expose an issue outside the configured team', async (t) => {
  const issue = linearIssue(7, 'triage', 1)
  const adapter = await setup(t, { singleIssue: { ...issue, identifier: 'OTHER-7' } })
  const ref = { source, itemId: issue.id, displayId: issue.identifier, url: issue.url }
  assert.equal(await adapter.get(ref), 'inaccessible')
  await assert.rejects(adapter.scan(), { name: 'TrackerError', reason: 'bad_response' })
})

test('Linear get and scan treat empty or non-string identifier as inaccessible or gone', async (t) => {
  const issue = linearIssue(7, 'triage', 1)
  const ref = { source, itemId: issue.id, displayId: issue.identifier, url: issue.url }
  for (const identifier of ['', 7]) {
    const adapter = await setup(t, { singleIssue: { ...issue, identifier } as typeof issue })
    await assert.rejects(adapter.get(ref), { name: 'TrackerError', reason: 'bad_response' }, `get: ${inspect(identifier)}`)
    await assert.rejects(adapter.scan(), { name: 'TrackerError', reason: 'bad_response' }, `scan: ${inspect(identifier)}`)
  }
})

for (const [failure, reason] of [['errors', 'bad_response'], ['rate', 'rate_limited'], [401, 'unauthorized'],
  [500, 'unavailable'], ['missing-labels', 'bad_response']] as const) {
  test(`Linear scan fails to report ${failure} as ${reason} or leaks its credential`, async (t) => {
    const adapter = await setup(t, { failure })
    await assert.rejects(adapter.scan(), (error) => {
      assert.ok(error instanceof TrackerError)
      assert.equal(error.reason, reason)
      assert.ok(!inspect(error, { showHidden: true }).includes(credential), 'credential leaked in thrown error')
      return true
    })
  })
}