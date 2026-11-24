import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { checkOverlap, mirrorStore, registerMirrorSchema, syncMirror,
  type Conflict, type MirrorItem, type MirrorRead, type MirrorReader } from '../src/mirror/index.ts'
import { runMirrorCommand, type MirrorCommandDeps } from '../src/mirror/command.ts'
import { workItemsFromFile, type WorkItemLinks } from '../src/mirror/work-items.ts'

const repo = 'acme/web'
const id = 'WP-42'
const work = { id, repo, branches: [], prs: [], trackerItems: [] } satisfies WorkItemLinks
const kinds = ['branch', 'issue', 'pr'] as const
const item = (kind: MirrorItem['kind'], key: string, fields: Partial<MirrorItem> = {}): MirrorItem =>
  ({ kind, key, repo, state: 'open', ...fields })
const complete = (...items: MirrorItem[]): MirrorRead[] => kinds.map((kind) =>
  ({ kind, complete: true, items: items.filter((row) => row.kind === kind) }))
const issueGap = 'issue: partial read (page_limit)'
const partialIssues = (...items: MirrorItem[]): MirrorRead[] => complete(...items).map((read) =>
  read.kind === 'issue' ? { ...read, complete: false, reason: 'page_limit' } : read)
const syncArgs = ['mirror', 'sync', '--repo', repo]

function fixture(t: TestContext) {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({ backend })
  const dir = mkdtempSync(join(tmpdir(), 'swarm-overlap-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'work.json')
  const overlapArgs = ['overlap', id, '--work', path]
  const writeWork = (data: unknown) => writeFileSync(path, JSON.stringify(data))
  const link = (links: Partial<WorkItemLinks> = {}) => writeWork({ items: [{ ...work, ...links }] })
  let time = Date.UTC(2026, 0, 1)
  const now = () => time
  const store = async () => mirrorStore({ board: team, author: (await team.me()).actor, now })
  const seed = async (reads: MirrorRead[]) => syncMirror({
    repo, store: await store(), now, reader: async () => reads,
  })
  const run = async (args: string[], deps: Pick<MirrorCommandDeps, 'reader' | 'workItems'> = {}) => {
    let stdout = '', stderr = ''
    const code = await runMirrorCommand(args, {
      board: team, now, reader: async () => complete(), ...deps,
      stdout: (text) => { stdout += text }, stderr: (text) => { stderr += text },
    })
    return { code, stdout, stderr }
  }
  link()
  return {
    register: () => registerMirrorSchema(team), seed, run, link, writeWork, overlapArgs,
    advance: (ms: number) => { time += ms },
    check: async (wrap: (mirror: Awaited<ReturnType<typeof store>>) => Parameters<typeof checkOverlap>[0]['store'] =
      (mirror) => mirror) => checkOverlap({ store: wrap(await store()), workId: id, now, workItems: workItemsFromFile(path) }),
  }
}

function reportsError(result: { code: number; stdout: string; stderr: string }, headline: RegExp) {
  assert.equal(result.code, 1, result.stderr)
  assert.match(result.stderr, headline)
  assert.doesNotMatch(result.stdout, /\bclear\b/u)
}

test('a linked live origin branch must be listed in plain text and exit 1', async (t) => {
  const f = fixture(t)
  await f.register()
  await f.seed(complete(item('branch', 'feature/repair')))
  f.link({ branches: ['feature/repair'] })
  const result = await f.check()
  assert.equal(result.status, 'conflicts')
  assert.deepEqual(result.conflicts.map(({ kind, key, origin }) => [kind, key, origin]),
    [['branch', 'feature/repair', 'origin branch']])
  const cli = await f.run(f.overlapArgs)
  assert.equal(cli.code, 1, cli.stderr)
  assert.match(cli.stdout, /^  branch +feature\/repair +on origin$/mu)
})

test('linked drafts count, but merged or closed PRs, gone branches and closed issues do not', async (t) => {
  const f = fixture(t)
  await f.register()
  await f.seed(complete(item('branch', 'retired')))
  f.advance(1)
  await f.seed(complete(item('pr', '1', { draft: true }), item('pr', '2', { state: 'merged' }),
    item('pr', '3', { state: 'closed' }), item('issue', '4', { state: 'closed' })))
  f.link({ branches: ['retired'], prs: [1, 2, 3], trackerItems: [{ source: 'github', ref: '#4' }] })
  const { conflicts } = await f.check()
  assert.deepEqual(conflicts.map(({ kind, key, origin }) => [kind, key, origin]), [['pr', '1', 'open draft PR']])
})

test('never-read, partial and stale mirror reads must not clear overlap', async (t) => {
  const f = fixture(t)
  await f.register()
  async function expectPartial(gaps: string[], ...flags: string[]) {
    const cli = await f.run([...f.overlapArgs, '--json', ...flags])
    assert.equal(cli.code, 1, cli.stderr || gaps.join(', '))
    const result = JSON.parse(cli.stdout)
    assert.equal(result.status, 'partial')
    assert.deepEqual(result.conflicts, [])
    assert.deepEqual(result.gaps.sort(), gaps.sort())
  }
  await expectPartial(kinds.map((kind) => `${kind}: never read`))
  await f.seed(partialIssues())
  await expectPartial([issueGap])
  f.advance(1)
  await f.seed(complete())
  f.advance(60_001)
  // Override the age so this also catches a CLI that ignores the flag.
  await expectPartial(kinds.map((kind) => `${kind}: stale read`), '--max-age-minutes', '1')
})

test('changed, future, or missing mirror data cannot clear overlap', async (t) => {
  const f = fixture(t)
  await f.register()
  await f.seed(complete())
  for (const change of [{ observedAt: '2025-12-31T23:59:59.999Z' }, { complete: false }]) {
    let listed = false
    const result = await f.check((store) => ({
      list: async (scope) => { listed = true; return store.list(scope) },
      status: { read: async (scope) => {
        const status = await store.status.read(scope)
        return status && scope.kind === 'pr' && listed ? { ...status, ...change } : status
      } },
    }))
    assert.equal(result.status, 'partial', 'changed PR status')
    assert.deepEqual(result.gaps, ['pr: mirror changed during read'])
  }

  f.advance(-1)
  const future = await f.check()
  assert.equal(future.status, 'partial', 'future-dated mirror status')
  assert.deepEqual(future.gaps.sort(), kinds.map((kind) => `${kind}: stale read`))
  let prReads = 0
  const caughtUp = await f.check((store) => ({ ...store, status: { read: async (scope) => {
    const status = await store.status.read(scope)
    if (scope.kind === 'pr' && ++prReads === 2) f.advance(1)
    return status
  } } }))
  assert.equal(caughtUp.status, 'clear', 'freshness uses the clock after the last board read')

  f.link({ branches: ['not-on-origin'], prs: [9], trackerItems: [{ source: 'github', ref: '#8' }] })
  const cli = await f.run([...f.overlapArgs, '--json'])
  assert.equal(cli.code, 1, cli.stderr)
  const { status, gaps } = JSON.parse(cli.stdout)
  assert.equal(status, 'partial')
  assert.deepEqual(gaps.sort(), ['issue #8: not in mirror', 'pr #9: not in mirror'])
})

test('unmirrored tracker links block clear even when all mirror reads are fresh', async (t) => {
  const f = fixture(t)
  await f.register()
  await f.seed(complete())
  for (const source of ['linear', 'beads'] as const) {
    f.link({ trackerItems: [{ source, ref: 'TRACK-7' }] })
    const cli = await f.run(f.overlapArgs)
    assert.equal(cli.code, 1, cli.stderr)
    assert.match(cli.stdout, /^WP-42  partial$/mu)
    assert.match(cli.stdout, new RegExp(`^  tracker ${source}: not read$`, 'mu'))
  }
  f.link()
  const cli = await f.run(f.overlapArgs)
  assert.equal(cli.code, 0, cli.stderr)
  assert.match(cli.stdout, /^WP-42  clear$/mu)
})

test('a linked open GitHub issue takes precedence over a partial read without hiding the gap', async (t) => {
  const f = fixture(t)
  await f.register()
  await f.seed(complete(item('issue', '5')).map((read) => read.kind === 'branch'
    ? { ...read, complete: false, reason: 'gh_failed' } : read))
  f.link({ trackerItems: [{ source: 'github', ref: `https://github.com/${repo}/issues/5` }] })
  const cli = await f.run([...f.overlapArgs, '--json'])
  assert.equal(cli.code, 1, cli.stderr)
  const { status, gaps, conflicts } = JSON.parse(cli.stdout)
  assert.equal(status, 'conflicts')
  assert.deepEqual(gaps, ['branch: partial read (gh_failed)'])
  assert.deepEqual(conflicts.map(({ kind, key, origin }: Conflict) => [kind, key, origin]),
    [['issue', '5', 'tracker item']])
})

test('overlap escapes controls in plain text and JSON stdout', async (t) => {
  const f = fixture(t)
  await f.register()
  const title = 'Fix\u009b cache', branch = 'feature/\u202erepair', workId = `${id}\u2066`
  await f.seed(complete(item('pr', '1', { title }), item('branch', branch)))
  f.link({ id: workId, branches: [branch], prs: [1] })
  const [, , ...flags] = f.overlapArgs
  for (const format of [[], ['--json']]) {
    const cli = await f.run(['overlap', workId, ...flags, ...format])
    assert.equal(cli.code, 1, cli.stderr)
    assert.doesNotMatch(cli.stdout, /[\u009b\u202e\u2066]/u, format.join() || 'plain text')
    for (const escaped of ['Fix\\u009b cache', 'feature/\\u202erepair', `${id}\\u2066`]) {
      assert.ok(cli.stdout.includes(escaped), `missing ${escaped}`)
    }
    if (format.length) assert.equal(JSON.parse(cli.stdout).status, 'conflicts')
  }
})

test('matching titles and branch names containing the work id never imply links', async (t) => {
  const f = fixture(t)
  await f.register()
  const title = 'Repair the cache'
  await f.seed(complete(item('pr', '1', { title }), item('branch', `feature/${id}-cache`)))
  // The work file only accepts links; a work adapter can supply a title too.
  const titled = { ...work, title }
  const cli = await f.run([...f.overlapArgs, '--json'], { workItems: { get: async () => titled } })
  assert.equal(cli.code, 0, cli.stderr)
  assert.deepEqual(JSON.parse(cli.stdout).conflicts, [])
})

test('an unknown work id is an error, not clear', async (t) => {
  const f = fixture(t)
  await f.register()
  await f.seed(complete())
  const [, , ...flags] = f.overlapArgs
  reportsError(await f.run(['overlap', 'WP-404', ...flags]), /^error: unknown work item\b/u)
})

test('mirror sync works on a fresh board, reports zero creations on rerun and emits one JSON document', async (t) => {
  const f = fixture(t)
  const reader: MirrorReader = async () => complete(item('pr', '1'), item('branch', 'main'), item('issue', '2'))
  for (const created of [1, 0]) {
    const cli = await f.run(syncArgs, { reader })
    assert.equal(cli.code, 0, `${created === 1 ? 'first sync on a fresh board' : 'rerun'}: ${cli.stderr}`)
    const rows = cli.stdout.trimEnd().split('\n')
    assert.equal(rows.length, kinds.length)
    for (const kind of kinds) {
      assert.ok(rows.some((row) => new RegExp(`^${kind} {2,}complete  seen 1  created ${created}  changed 0$`, 'u').test(row)),
        `missing ${kind} row with created ${created}`)
    }
  }
  const cli = await f.run([...syncArgs, '--json'], { reader })
  assert.equal(cli.code, 0, cli.stderr)
  const { kinds: rows } = JSON.parse(cli.stdout)
  assert.deepEqual(rows.map(({ kind }: { kind: string }) => kind).sort(), [...kinds])
})

test('a skipped older sync reports stale and exits 1', async (t) => {
  const f = fixture(t)
  assert.equal((await f.run(syncArgs)).code, 0)
  f.advance(-1)
  const cli = await f.run(syncArgs)
  assert.match(cli.stdout, /^pr +stale +seen 0  created 0  changed 0$/mu)
  assert.equal(cli.code, 1, cli.stderr)
  const json = await f.run([...syncArgs, '--json'])
  assert.equal(json.code, 1, json.stderr)
  for (const { stale, complete } of JSON.parse(json.stdout).kinds) {
    assert.equal(stale, true)
    assert.equal(complete, false)
  }
})

test('neither command leaks a credential from an adapter error in text or JSON mode', async (t) => {
  const f = fixture(t)
  await f.register()
  const credential = ['fake', 'overlap', 'credential'].join('-')
  const fail = async () => { throw new Error(`authentication failed: ${credential}`) }
  for (const flags of [[], ['--json']]) {
    const sync = await f.run([...syncArgs, ...flags], { reader: fail })
    const overlap = await f.run([...f.overlapArgs, ...flags])
    // Overlap doesn't call the reader; also exercise its own error path.
    const failedOverlap = await f.run([...f.overlapArgs, ...flags], { workItems: { get: fail } })
    for (const { code, stdout, stderr } of [sync, overlap, failedOverlap]) {
      assert.ok(!stdout.includes(credential) && !stderr.includes(credential), 'credential leaked')
      assert.equal(code, 1)
    }
    if (flags.length) {
      assert.ok(JSON.parse(sync.stdout).kinds.every(({ reason }: { reason: string }) => reason === 'gh_failed'))
      assert.equal(JSON.parse(overlap.stdout).status, 'partial')
    } else {
      assert.match(sync.stdout, /partial \(gh_failed\)/u)
      assert.match(overlap.stdout, /^WP-42  partial$/mu)
    }
    assert.match(failedOverlap.stderr, /^error: /u)
  }
})

test('work files reject duplicate keys, invalid branches, and unsafe files', async (t) => {
  const f = fixture(t)
  await f.register()
  await f.seed(complete())
  const path = f.overlapArgs.at(-1)!
  const invalid = async () => reportsError(await f.run(f.overlapArgs), /^error: invalid work file\b/u)
  const duplicate = JSON.stringify({ items: [{ ...work, prs: [9] }] }).replace('"prs":[9]', '"prs":[9],"prs":[]')
  writeFileSync(path, duplicate)
  await invalid()
  f.link({ branches: ['feature branch'] })
  await invalid()
  writeFileSync(path, JSON.stringify({ items: [work] }).padEnd(1024 * 1024 + 1))
  await invalid()
  f.link()
  renameSync(path, `${path}.target`)
  symlinkSync(`${path}.target`, path)
  await invalid()
})

test('malformed or missing work files error and CLI misuse does not break config show', async (t) => {
  const f = fixture(t)
  await f.register()
  await f.seed(complete())
  for (const invalid of [{ ...work, unexpected: true }, { ...work, prs: '1' }]) {
    f.writeWork({ items: [invalid] })
    reportsError(await f.run(f.overlapArgs), /^error: invalid work file\b/u)
  }
  const missing = [...f.overlapArgs.slice(0, -1), `${f.overlapArgs.at(-1)}.missing`]
  reportsError(await f.run(missing), /^error: cannot read work file\b/u)

  const spawn = (...args: string[]) => {
    const result = spawnSync(process.execPath, ['src/cli.ts', ...args], {
      cwd: new URL('../', import.meta.url), encoding: 'utf8',
    })
    if (result.error) throw result.error
    return result
  }
  const misuse = spawn('overlap')
  assert.equal(misuse.status, 2, misuse.stderr)
  assert.match(misuse.stderr, /^error: /mu)
  const config = spawn('config', 'show', '--json')
  assert.equal(config.status, 0, config.stderr)
  assert.ok(JSON.parse(config.stdout).claims.hours > 0)
})
