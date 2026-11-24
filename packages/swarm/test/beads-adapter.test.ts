import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  BdParseError, beadsAdapter, fixtureRunner, parseBlocked, parseIssues, renderQueue,
  type BdRunner, type ScanResult,
} from '../src/trackers/beads/index.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/bd-1.3.4.json', import.meta.url), 'utf8')) as {
  calls: { argv: string[]; stdout: string }[]
}
const recorded = fixtureRunner(fixture)
const epic = 'rw-cn1'
const gatedEpic = 'rw-xae'

function adapter(run: BdRunner = recorded, maxBeads?: number) {
  return beadsAdapter({ run, store: 'rw', now: () => new Date('2026-11-22T20:00:00Z'),
    ...(maxBeads === undefined ? {} : { maxBeads }) })
}

function runnableIds({ items }: ScanResult) {
  return items.filter(({ runnable }) => runnable.runnable).map(({ id }) => id).sort()
}

function reasonsFor({ items }: ScanResult, id: string) {
  const item = items.find((item) => item.id === id)
  assert.ok(item, `missing ${id}`)
  assert.equal(item.runnable.runnable, false, `${id} should not be runnable`)
  return item.runnable.reasons
}

test('rebuilding readiness from edges disagrees with the recorded bd ready set', async () => {
  const ready = fixture.calls.find(({ argv }) => argv[0] === 'ready' && argv.at(-1) === epic)
  assert.ok(ready, `missing recorded ready output for ${epic}`)
  const expected = (JSON.parse(ready.stdout) as { id: string }[]).map(({ id }) => id).sort()
  const tracker = adapter()
  assert.deepEqual(runnableIds(await tracker.scan({ epic })), expected)
  assert.deepEqual(runnableIds(await tracker.scan({ epic: gatedEpic })), [])
})

test('not-runnable beads lose a reason or its close text, assignee, or defer date', async () => {
  const tracker = adapter()
  const main = await tracker.scan({ epic })
  for (const { items } of [main, await tracker.scan({ epic: gatedEpic })]) {
    for (const { id, runnable } of items) {
      if (!runnable.runnable) assert.ok(runnable.reasons.length > 0, `missing reason for ${id}`)
    }
  }
  assert.deepEqual(reasonsFor(main, 'rw-cn1.6').find(({ kind }) => kind === 'closed'),
    { kind: 'closed', detail: 'already done in merged PR' })
  assert.deepEqual(reasonsFor(main, 'rw-cn1.4').find(({ kind }) => kind === 'in_progress'),
    { kind: 'in_progress', assignee: 'charlie' })
  assert.deepEqual(reasonsFor(main, 'rw-cn1.5').find(({ kind }) => kind === 'deferred'),
    { kind: 'deferred', until: '2026-12-22T19:48:49Z' })
})

test('the cross-check misses or mislabels parent gates or reports the wrong seeded disagreements', async () => {
  const tracker = adapter()
  const gated = await tracker.scan({ epic: gatedEpic })
  const parentReason = { kind: 'blocked_by', ids: [gatedEpic], via: 'parent' }
  const parentIds = ['rw-xae.1', 'rw-xae.2']
  for (const id of parentIds) {
    assert.deepEqual(reasonsFor(gated, id).find(({ kind }) => kind === 'blocked_by'), parentReason)
  }
  const main = await tracker.scan({ epic })
  assert.deepEqual(gated.disagreements.slice().sort((a, b) => a.id.localeCompare(b.id)), parentIds.map((id) => ({
    id, kind: 'bd_withholds', bdReady: false, derivedReady: true, reasons: [parentReason],
  })))
  assert.deepEqual(main.disagreements, [{
    id: 'rw-cn1.12', kind: 'bd_withholds', bdReady: false, derivedReady: true,
    reasons: [{ kind: 'blocked_by', ids: ['rw-cn1.1'], via: 'edge' }],
  }])
})

test('a one-level scan drops the grandchild rw-cn1.2.1', async () => {
  const { items } = await adapter().scan({ epic })
  assert.ok(items.some(({ id }) => id === 'rw-cn1.2.1'), 'scan omitted the grandchild')
})

test('a scan at the bead cap returns a partial list as if complete', async () => {
  await assert.rejects(adapter(recorded, 3).scan({ epic }), /epic too large/)
})

test('a race between list and ready hides disagreements or invents an unlisted item', async () => {
  const workingId = 'rw-cn1.4'
  const unlistedId = 'rw-cn1.removed'
  const run: BdRunner = async (argv) => {
    const stdout = await recorded(argv)
    if (argv[0] !== 'ready' || argv.at(-1) !== epic) return stdout
    const rows = JSON.parse(stdout) as unknown[]
    return JSON.stringify([...rows,
      { id: workingId, status: 'open', title: 'listed as ready by bd' },
      { id: unlistedId, status: 'open', title: 'not in list' },
    ])
  }
  const { items, disagreements } = await adapter(run).scan({ epic })
  assert.deepEqual(disagreements.find(({ id }) => id === workingId), {
    id: workingId, kind: 'bd_offers', bdReady: true, derivedReady: false,
    reasons: [{ kind: 'in_progress', assignee: 'charlie' }],
  })
  assert.deepEqual(disagreements.find(({ id }) => id === unlistedId), {
    id: unlistedId, kind: 'unlisted', bdReady: true, derivedReady: false, reasons: [],
  })
  assert.ok(!items.some(({ id }) => id === unlistedId), 'a ready-only id appeared as an item')
})

test('a race between list and blocked hides an unlisted bead', async () => {
  const blockedOnly = 'rw-cn1.blocked-only'
  const inBoth = 'rw-cn1.in-both'
  const run: BdRunner = async (argv) => {
    const stdout = await recorded(argv)
    if (argv.at(-1) !== epic || (argv[0] !== 'blocked' && argv[0] !== 'ready')) return stdout
    const rows = JSON.parse(stdout) as unknown[]
    return JSON.stringify([...rows, { id: inBoth, status: 'open' },
      ...(argv[0] === 'blocked' ? [{ id: blockedOnly, status: 'blocked', blocked_by: [epic] }] : []),
    ])
  }
  const { items, disagreements } = await adapter(run).scan({ epic })
  for (const [id, bdReady] of [[blockedOnly, false], [inBoth, true]] as const) {
    assert.deepEqual(disagreements.filter((entry) => entry.id === id), [{
      id, kind: 'unlisted', bdReady, derivedReady: false, reasons: [],
    }])
    assert.ok(!items.some((item) => item.id === id), `${id} appeared as an item`)
  }
})

test('scan or get invokes show or another verb outside the read-only allowlist', async () => {
  const calls: (readonly string[])[] = []
  const tracker = adapter(async (argv) => {
    calls.push(argv)
    return recorded(argv)
  })
  try {
    await tracker.scan({ epic })
    await tracker.get('rw-cn1.3')
  } finally {
    for (const argv of calls) {
      assert.ok(['list', 'ready', 'blocked'].some((verb) => verb === argv[0]), `unexpected verb: ${argv.join(' ')}`)
    }
  }
})

test('get loses the blocked reason or returns an item for an absent id', async () => {
  const tracker = adapter(async (argv) =>
    argv[0] === 'list' && argv.at(-2) === '--id' && argv.at(-1) === 'rw-nope' ? '[]' : recorded(argv))
  const item = await tracker.get('rw-cn1.3')
  assert.equal(item?.id, 'rw-cn1.3')
  assert.equal(item.runnable.runnable, false)
  assert.ok(item.runnable.reasons.some(({ kind }) => kind === 'blocked_by'))
  assert.equal(await tracker.get('rw-nope'), undefined)
})

test('parsing accepts invalid output, echoes raw output in an error, or keeps an owner email', () => {
  for (const parse of [parseIssues, parseBlocked]) {
    for (const raw of ['{private-bd-output', '{"title":"private-bd-output"}',
      '[{"status":"open","title":"private-bd-output"}]']) {
      assert.throws(() => parse(raw), (error) => {
        assert.ok(error instanceof BdParseError, `${parse.name} did not throw BdParseError`)
        assert.doesNotMatch(error.message, /private-bd-output/)
        return true
      }, `${parse.name} accepted ${raw}`)
    }
    const parsed = parse('[{"id":"rw-demo","status":"open","owner":"owner@example.invalid"}]')
    assert.doesNotMatch(JSON.stringify(parsed), /@/)
  }
})

test('redaction merges distinct email-shaped bead ids instead of rejecting them', () => {
  const stdout = JSON.stringify(['first@example.invalid', 'second@example.invalid'].map((id) => ({ id, status: 'open' })))
  assert.throws(() => parseIssues(stdout), (error) =>
    error instanceof BdParseError && error.message === 'invalid bd list output')
})

test('scan leaks credentials or keeps malformed external refs from list output', async () => {
  const run: BdRunner = async (argv) => {
    const stdout = await recorded(argv)
    if (argv[0] !== 'list' || argv.at(-1) !== epic) return stdout
    const rows = JSON.parse(stdout) as { id: string; external_ref?: string }[]
    return JSON.stringify(rows.map((row) => {
      if (row.id === 'rw-cn1.1') return {
        ...row,
        external_ref: 'https://user:pw@example.com/ada@example.invalid/SECRET?access_token=SECRET#frag',
      }
      if (row.id === 'rw-cn1.2') return { ...row, external_ref: 'not a ref; DROP TABLE' }
      return row
    }))
  }
  const scan = await adapter(run).scan({ epic })
  assert.doesNotMatch(JSON.stringify(scan), /SECRET|pw|ada@example\.invalid/)
  assert.equal(scan.items.find(({ id }) => id === 'rw-cn1.1')?.externalRef, 'https://example.com')
  assert.equal(scan.items.find(({ id }) => id === 'rw-cn1.8')?.externalRef, 'gh-925')
  const malformed = scan.items.find(({ id }) => id === 'rw-cn1.2')
  assert.ok(malformed)
  assert.equal(malformed.externalRef, undefined)
})

test('the rendered queue exceeds 80 columns or prints a title with raw ESC', async () => {
  const tracker = adapter()
  const main = await tracker.scan({ epic })
  const gated = await tracker.scan({ epic: gatedEpic })
  const longTitle = {
    ...main,
    items: main.items.map((item) => item.id === 'rw-cn1.1'
      ? { ...item, title: 'escape \u001b ' + 'long title '.repeat(12) } : item),
  }
  const escaped = renderQueue(longTitle)
  assert.ok(!escaped.includes('\u001b'), 'title contains a raw terminal escape')
  assert.match(escaped, /escape \\u001b/)
  for (const queue of [renderQueue(main), renderQueue(gated), escaped]) {
    for (const line of queue.split('\n')) assert.ok(line.length <= 80, `line exceeds 80 columns: ${line}`)
  }
})

test('an unrecorded argv looks like an empty scan instead of surfacing the fixture error', async () => {
  const epic = 'sk-livetestkey'
  await assert.rejects(adapter().scan({ epic }), (error) => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'unrecorded call')
    assert.equal(error.message.includes(epic), false)
    return true
  })
})
