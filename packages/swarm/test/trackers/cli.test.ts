import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fakeGitHub } from './fake-github.ts'
import { fakeLinear, linearIssue } from './fake-linear.ts'

const gh = 'github:acme/web', lin = 'linear:KEY'
const tokens = { GITHUB_TOKEN: 'dummy-github-cli-token', LINEAR_API_KEY: 'dummy-linear-cli-key' }
type Credential = keyof typeof tokens
type Request = { authorization?: string; elsewhere: string }

async function setup(t: TestContext, { seeded = false, status }: { seeded?: boolean; status?: 401 | 500 } = {}) {
  const labels = seeded ? ['work:plb-1'] : []
  const [github, linear] = await Promise.all([
    fakeGitHub(t, labels), fakeLinear(t, { failure: status,
      singleIssue: { ...linearIssue(17, 'started', 2, labels), title: seeded ? 'issue 17' : 'issue 7' } }),
  ])
  const dir = mkdtempSync(join(tmpdir(), 'swarm-trackers-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const party = join(dir, 'party.json')
  function configure(sources = [gh, lin], precedence = sources) {
    writeFileSync(party, JSON.stringify({ trackers: { acme: { sources, precedence } } }))
  }
  configure()
  async function run(args = ['acme'], without?: Credential) {
    const env = { ...process.env, ...tokens, SWARM_GITHUB_API_URL: github.baseUrl, SWARM_LINEAR_API_URL: linear.baseUrl }
    if (without) delete env[without]
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      execFile(process.execPath, ['src/cli.ts', 'trackers', 'scan', ...args, '--party', party], {
        cwd: new URL('../../', import.meta.url), env, timeout: 5000,
      }, (error, stdout, stderr) => {
        const code = error ? error.code : 0
        if (typeof code !== 'number') return reject(error)
        resolve({ code, stdout, stderr })
      })
    })
    for (const token of Object.values(tokens)) {
      assert.ok(!result.stdout.includes(token), 'credential leaked on stdout')
      assert.ok(!result.stderr.includes(token), 'credential leaked on stderr')
    }
    return result
  }
  return { github, linear, configure, run }
}

function headerOnly(requests: Request[], authorization: string) {
  assert.ok(requests.length > 0, 'no request received')
  for (const request of requests) {
    assert.ok(request.authorization === authorization, 'incorrect Authorization header')
    assert.ok(Object.values(tokens).every((token) => !request.elsewhere.includes(token)), 'credential sent outside Authorization')
  }
}

test('seeded scan splits the work item, loses a badge or disagreement, or ignores precedence in text or JSON', async (t) => {
  const { configure, run } = await setup(t, { seeded: true })
  const complete = { status: 'complete', pages: 1 }
  for (const [winner, loser, state, other, title, badges] of [
    [gh, lin, 'done', 'open', 'issue 7', ['GH#7', 'LIN KEY-17']],
    [lin, gh, 'open', 'done', 'issue 17', ['LIN KEY-17', 'GH#7']],
  ] as const) {
    configure([gh, lin], [winner, loser])
    const expectedRow = `${state}  ${badges.join(' ')}  ${title}  disagrees: ${loser}=${other}`
    const text = await run()
    assert.deepEqual(text, { code: 0, stderr: '', stdout:
      `${expectedRow}\n\n${winner}  complete  1 pages\n${loser}  complete  1 pages\n` })
    const json = await run(['acme', '--json'])
    assert.equal(json.code, 0)
    assert.equal(json.stderr, '')
    assert.deepEqual(JSON.parse(json.stdout), { items: [{ key: 'work:plb-1', workId: 'plb-1', title, badges, state,
      stateSource: winner, disagreements: [{ source: loser, state: other }], stale: false }],
    sources: { [gh]: complete, [lin]: complete } })
    for (const line of text.stdout.trimEnd().split('\n')) t.diagnostic(line)
    t.diagnostic(json.stdout.trimEnd())
  }
})

test('scan merges unlinked GitHub and Linear issues with the same title', async (t) => {
  const { run } = await setup(t)
  const { code, stdout, stderr } = await run()
  assert.equal(code, 0, stderr)
  assert.deepEqual(stdout.split('\n\n')[0]?.split('\n').sort(), ['done  GH#7  issue 7', 'open  LIN KEY-17  issue 7'])
})

test('successful scan sends a write, leaks a credential, or uses the wrong Authorization header', async (t) => {
  const { run, github, linear } = await setup(t)
  for (const flags of [[], ['--json']]) {
    const result = await run(['acme', ...flags])
    assert.deepEqual(github.rejected, [], 'GitHub scan used a non-GET method')
    assert.deepEqual(linear.rejected, [], 'Linear scan sent a non-query document')
    assert.equal(result.code, 0, result.stderr)
  }
  headerOnly(github.requests, `Bearer ${tokens.GITHUB_TOKEN}`)
  headerOnly(linear.requests, tokens.LINEAR_API_KEY)
})

for (const [without, source] of [['GITHUB_TOKEN', gh], ['LINEAR_API_KEY', lin]] as const) {
  test(`scan requests ${source} without a credential, hides no_credential, or leaks a token`, async (t) => {
    const { run, github, linear } = await setup(t)
    const [absent, present, auth] = source === gh ? [github, linear, tokens.LINEAR_API_KEY]
      : [linear, github, `Bearer ${tokens.GITHUB_TOKEN}`]
    for (const flags of [[], ['--json']]) {
      const { code, stdout, stderr } = await run(['acme', ...flags], without)
      assert.deepEqual(absent.requests, [], 'request sent before rejecting absent credential')
      assert.equal(code, 1)
      assert.equal(stderr, '')
      if (flags.length) assert.deepEqual(JSON.parse(stdout).sources[source], { status: 'error', pages: 0, reason: 'no_credential' })
      else assert.ok(stdout.includes(`\n${source}  error  0 pages  no_credential\n`))
    }
    headerOnly(present.requests, auth)
  })
}

for (const [status, reason] of [[401, 'unauthorized'], [500, 'unavailable']] as const) {
  test(`scan with HTTP ${status} exits successfully, loses healthy rows or source status, or leaks a token`, async (t) => {
    for (const [broken, healthy, row, badge] of [[lin, gh, 'done  GH#7  issue 7', 'GH#7'],
      [`github:acme/${status}`, lin, 'open  LIN KEY-17  issue 7', 'LIN KEY-17']] as const) {
      const { run, configure, github, linear } = await setup(t, { status: broken === lin ? status : undefined })
      configure([broken, healthy])
      for (const flags of [[], ['--json']]) {
        const { code, stdout, stderr } = await run(['acme', ...flags])
        assert.equal(code, 1)
        assert.equal(stderr, '')
        if (flags.length) {
          const { items, sources } = JSON.parse(stdout)
          assert.deepEqual(items.map((item: { badges: string[] }) => item.badges), [[badge]])
          assert.deepEqual(sources, { [broken]: { status: 'error', pages: 0, reason }, [healthy]: { status: 'complete', pages: 1 } })
        } else {
          assert.equal(stdout, `${row}\n\n${broken}  error  0 pages  ${reason}\n${healthy}  complete  1 pages\n`)
        }
      }
      headerOnly(github.requests, `Bearer ${tokens.GITHUB_TOKEN}`)
      headerOnly(linear.requests, tokens.LINEAR_API_KEY)
    }
  })
}

test('a later page failure exits zero, loses scanned rows, or hides partial status', async (t) => {
  const { run, configure } = await setup(t)
  configure(['github:acme/2', lin])
  const { code, stdout, stderr } = await run()
  assert.equal(code, 1)
  assert.equal(stderr, '')
  assert.match(stdout, /^unknown  GH#12  issue 12  stale\nopen  LIN KEY-17  issue 7\n/)
  assert.match(stdout, /^github:acme\/2  partial  1 pages  unavailable$/m)
})

for (const [failure, args, error] of [
  ['unknown repo key', ['unknown'], /^error: unknown repo key\n$/],
  ['missing repo argument', [], /^error: missing repo key\n$/],
  ['bad flag', ['acme', '--bogus'], /^error: .*--bogus.*\n$/],
  ['malformed source id', ['acme'], /^error: bad source id\n$/],
] as const) {
  test(`scan prints rows, omits the error, or fails to exit 2 for: ${failure}`, async (t) => {
    const { configure, run } = await setup(t)
    if (failure === 'malformed source id') configure([gh, 'linear:bad/key'], [gh])
    const { code, stdout, stderr } = await run([...args])
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.match(stderr, error)
  })
}
