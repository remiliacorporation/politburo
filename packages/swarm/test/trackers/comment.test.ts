import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test, type TestContext } from 'node:test'
import { commentOn, githubAdapter, linearAdapter, TrackerError, type SourceRef } from '../../src/trackers/index.ts'
import { fakeGitHub } from './fake-github.ts'
import { fakeLinear, linearIssue } from './fake-linear.ts'

const credential = 'dummy-comment-token-do-not-expose'
const body = 'Progress update\nReady for review', opId = 'review:407'
const marked = `${body}\n<!-- politburo-op:review:407 -->`
const enabled = { writeBack: 'comments' } as const
const kinds = ['GitHub', 'Linear'] as const
const github = { source: 'github:acme/web', itemId: 'I_7', displayId: '7', url: 'https://example.invalid/acme/web/issues/7' }
const issue = linearIssue(7, 'started', 1)
const linear = { source: 'linear:KEY', itemId: issue.id, displayId: issue.identifier, url: issue.url }
type Kind = 'GitHub' | 'Linear'

async function setup(t: TestContext, kind: Kind, options: {
  createdPage?: number; pages?: number; missingCursor?: boolean; failure?: 500 | 'drop' | 'unsuccessful'
  fetch?: typeof fetch; linearIdentifier?: string
} = {}) {
  const isGitHub = kind === 'GitHub'
  const { failure, fetch, linearIdentifier, ...pages } = options
  const fake = isGitHub ? await fakeGitHub(t, undefined, { ...pages, failure: failure === 'unsuccessful' ? undefined : failure })
    : await fakeLinear(t, { comments: { ...pages, failure },
      singleIssue: linearIdentifier ? { ...issue, identifier: linearIdentifier } : undefined })
  const ref: SourceRef = isGitHub ? github : linear
  let credentialReads = 0
  const build = (options: { writeBack?: 'off' | 'comments' | 'transitions' } = {}) =>
    (isGitHub ? githubAdapter : linearAdapter)({ source: ref.source, baseUrl: fake.baseUrl, fetch,
      token: () => { credentialReads++; return credential }, ...options })
  const adapter = build(enabled)
  const writes = () => fake.requests.filter(({ method, body }) => isGitHub ? method === 'POST' : /\bmutation\b/.test(body))
  const noIO = () => {
    assert.equal(fake.requests.length, 0, 'request sent before rejecting comment')
    assert.equal(credentialReads, 0, 'token read before rejecting comment')
  }
  t.after(() => assert.deepEqual(fake.rejected, [], 'unexpected HTTP method or GraphQL operation'))
  return { ...fake, ref, adapter, build, writes, noIO }
}

async function rejects(call: Promise<unknown>, reason: TrackerError['reason']) {
  await assert.rejects(call, (error: unknown) => {
    assert.ok(error instanceof TrackerError)
    for (const [surface, text] of Object.entries({ message: error.message, stack: error.stack, json: JSON.stringify(error) })) {
      assert.ok(!text?.includes(credential), `token leaked in error ${surface}`)
    }
    assert.equal(error.reason, reason)
    return true
  })
}

for (const kind of kinds) {
  for (const options of [undefined, { writeBack: 'off' }] as const) {
    test(`${kind} ${options ? 'explicit off' : 'default'} touches the tracker or token, or fails to report write_disabled`, async (t) => {
      const { adapter, ref, noIO } = await setup(t, kind)
      await rejects(commentOn([adapter], ref, body, opId, options), 'write_disabled')
      noIO()
    })
  }

  for (const createdPage of [1, 2]) {
    test(`${kind} replay misses the marker on page ${createdPage} or writes a duplicate`, async (t) => {
      const { adapter, ref, writes } = await setup(t, kind, { createdPage })
      assert.equal((await commentOn([adapter], ref, body, opId, enabled)).alreadyApplied, false)
      const replay = await commentOn([adapter], ref, 'Edited progress update', opId, enabled)
      assert.equal(writes().length, 1, 'replay sent a second write')
      assert.deepEqual(replay, { receipt: kind === 'GitHub' ? '1' : 'comment-1', alreadyApplied: true })
    })
  }

  test(`${kind} writes or fails to report unavailable when lookup still has a next page at the cap`, async (t) => {
    const { adapter, ref, writes, requests } = await setup(t, kind, { pages: 11 })
    await rejects(commentOn([adapter], ref, body, opId, enabled), 'unavailable')
    assert.equal(writes().length, 0, 'incomplete lookup sent a write')
    assert.equal(requests.length, 11, 'expected the target check and ten comment pages')
  })

  for (const failure of [500, 'drop'] as const) {
    test(`${kind} retries the write, fails to report unavailable, or leaks a token after ${failure}`, async (t) => {
      const { adapter, ref, writes } = await setup(t, kind, { failure })
      await rejects(commentOn([adapter], ref, body, opId, enabled), 'unavailable')
      assert.equal(writes().length, 1, 'expected exactly one attempted write')
    })
  }

  for (const [invalid, badBody, badId] of [
    ['empty body', ' \n ', opId], ['over-long body', 'x'.repeat(4001), opId],
    ['control character', 'line\x00break', opId], ['bad opId', body, 'bad id!!'],
  ] as const) {
    test(`${kind} accepts ${invalid} or sends a request before rejecting it`, async (t) => {
      const { adapter, ref, noIO } = await setup(t, kind)
      await rejects(commentOn([adapter], ref, badBody, badId, enabled), 'bad_request')
      noIO()
    })
  }

  test(`${kind} sends the wrong comment or receipt, or puts the token outside Authorization`, async (t) => {
    const { adapter, ref, writes, requests } = await setup(t, kind)
    const receipt = await commentOn([adapter], ref, body, opId, enabled)
    assert.deepEqual(receipt, { receipt: kind === 'GitHub' ? 'IC_1' : 'comment-1', alreadyApplied: false })
    const sent = writes()
    assert.equal(sent.length, 1)
    assert.equal(sent[0]!.method, 'POST')
    const payload = JSON.parse(sent[0]!.body)
    if (kind === 'GitHub') assert.deepEqual(payload, { body: marked })
    else {
      assert.match(payload.query, /^mutation\b[\s\S]*\bcommentCreate\s*\(/)
      assert.deepEqual(payload.variables, { issueId: ref.itemId, body: marked })
    }
    for (const request of requests) {
      assert.ok(request.authorization === (kind === 'GitHub' ? `Bearer ${credential}` : credential), 'wrong Authorization header')
      assert.ok(!request.elsewhere.includes(credential), 'token sent outside Authorization')
    }
  })
}

test('Linear writes or fails to report unavailable when the next cursor is missing', async (t) => {
  const { adapter, ref, writes } = await setup(t, 'Linear', { pages: 2, missingCursor: true })
  await rejects(commentOn([adapter], ref, body, opId, enabled), 'unavailable')
  assert.equal(writes().length, 0)
})

test('Linear accepts commentCreate success:false or leaks a token in the error', async (t) => {
  const { adapter, ref, writes } = await setup(t, 'Linear', { failure: 'unsuccessful' })
  await rejects(commentOn([adapter], ref, body, opId, enabled), 'bad_response')
  assert.equal(writes().length, 1)
})

test('an unknown source routes to another tracker or fails to report bad_source', async (t) => {
  const { adapter, noIO } = await setup(t, 'GitHub')
  await rejects(commentOn([adapter], { ...github, source: 'github:other/repo' }, body, opId, enabled), 'bad_source')
  noIO()
})

test('an adapter without comment support fails to report write_disabled', async (t) => {
  const { adapter: { source, scan, get }, ref, noIO } = await setup(t, 'GitHub')
  await rejects(commentOn([{ source, scan, get }], ref, body, opId, enabled), 'write_disabled')
  noIO()
})

test('adapter write gate can be bypassed or reads the token when disabled', async (t) => {
  for (const kind of kinds) {
    const { build, ref, noIO } = await setup(t, kind)
    for (const options of [undefined, { writeBack: 'off' }] as const) {
      const adapter = build(options)
      await rejects(adapter.comment!(ref, body, opId), 'write_disabled')
      await rejects(commentOn([adapter], ref, body, opId, enabled), 'write_disabled')
      noIO()
    }
    const transitions = { writeBack: 'transitions' } as const
    const adapter = build(transitions)
    assert.equal((await commentOn([adapter], ref, body, opId, transitions)).alreadyApplied, false)
  }
})

test('reserved marker text or a credential in a comment body or operation ID reaches the tracker', async (t) => {
  for (const kind of kinds) {
    const { adapter, ref, requests } = await setup(t, kind)
    for (const [text, id] of [
      ['Mentioning politburo-op: is not allowed', opId],
      [`Progress: ${credential}`, opId],
      [body, `review:${credential}`],
    ] as const) {
      await rejects(adapter.comment!(ref, text, id), 'bad_request')
      assert.deepEqual(requests, [], `${kind} sent a request before rejecting invalid input`)
    }
  }
})

test('a 307 is followed on a comment lookup or mutation instead of reporting unavailable', async (t) => {
  const followed: string[] = []
  let redirects = 0
  const server = createServer((req, res) => {
    req.resume()
    if (req.url === '/start') {
      redirects++
      res.writeHead(307, { Location: '/destination' })
    } else {
      followed.push(req.method!)
      res.writeHead(503)
    }
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  for (const kind of kinds) {
    for (const redirectMutation of [false, true]) {
      const { adapter, ref } = await setup(t, kind, { fetch: (url, init) => {
        const isMutation = kind === 'GitHub' ? init?.method === 'POST' : /\bmutation\b/.test(String(init?.body))
        return fetch(isMutation === redirectMutation ? `http://127.0.0.1:${address.port}/start` : url, init)
      } })
      const before = redirects
      await rejects(adapter.comment!(ref, body, opId), 'unavailable')
      assert.equal(redirects, before + 1, `${kind} did not encounter a 307`)
      assert.deepEqual(followed, [], `${kind} followed the 307`)
    }
  }
})

test('a comment writes to a mismatched issue or a Linear issue outside the configured team', async (t) => {
  const gh = await setup(t, 'GitHub')
  await rejects(gh.adapter.comment!({ ...gh.ref, itemId: 'not-I_7' }, body, opId), 'bad_request')
  assert.deepEqual(gh.writes(), [])

  for (const [displayId, linearIdentifier] of [['KEY-8', 'KEY-7'], ['OTHER-7', 'OTHER-7']] as const) {
    const lin = await setup(t, 'Linear', { linearIdentifier })
    await rejects(lin.adapter.comment!({ ...lin.ref, displayId }, body, opId), 'bad_request')
    assert.deepEqual(lin.writes(), [])
  }
})

test('concurrent comments for one operation create duplicates or prevent a later replay', async (t) => {
  for (const kind of kinds) {
    let published = false
    const { adapter, build, ref, writes } = await setup(t, kind, { fetch: (url, init) => {
      // The tracker does not expose new comments to lookups until both callers settle.
      if (!published) {
        if (kind === 'GitHub' && init?.method === 'GET' && String(url).includes('/comments?')) {
          return Promise.resolve(Response.json([]))
        }
        if (kind === 'Linear' && /\bcomments\(first:/.test(String(init?.body))) {
          return Promise.resolve(Response.json({ data: { issue: {
            comments: { nodes: [], pageInfo: { hasNextPage: false } } } } }))
        }
      }
      return fetch(url, init)
    } })
    const [first, second] = await Promise.all([
      adapter.comment!(ref, body, opId), build(enabled).comment!({ ...ref }, body, opId),
    ])
    assert.equal(writes().length, 1, `${kind} created duplicate comments`)
    assert.equal(first.alreadyApplied, false)
    assert.deepEqual(second, first)
    published = true
    assert.equal((await adapter.comment!(ref, body, opId)).alreadyApplied, true)
  }
})
