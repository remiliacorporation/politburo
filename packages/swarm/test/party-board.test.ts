import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { test, type TestContext } from 'node:test'
import { board, type Board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import {
  applyGrants, auditGrants, channelsFor, partyOfRecord, partyWriter, principalOf, RegistryError,
  removeMember, removeParty, rowsOfParty, setMember,
  type Registry,
} from '../src/index.ts'

const people = {
  jockey: 'jockey@example.test', stranger: 'stranger@example.test',
  red: 'red@example.test', redReader: 'red-reader@example.test',
  blue: 'blue@example.test', blueReader: 'blue-reader@example.test',
}
const parties = [
  { id: 'default', colour: '#b3261e', member: 'red', reader: 'redReader', other: 'blue' },
  { id: 'blue', colour: '#263cb3', member: 'blue', reader: 'blueReader', other: 'default' },
] as const
const registry: Registry = {
  version: 1, jockeys: [people.jockey],
  parties: parties.map(({ id, colour, member, reader }) => ({
    id, colour, name: id,
    members: [{ email: people[member], role: 'member' }, { email: people[reader], role: 'reader' }],
  })),
}
const repo = { kind: 'repo' } as const
const work = 'work/x'
const inbox = (party: string) => `party/${party}/inbox`
const shared = ['intake', work, 'mirror/x']
const channels = [...shared, ...parties.map(({ id }) => inbox(id))]
const paths = async (handle: Board) => (await handle.channels()).channels.map(({ path }) => path).sort()
const forbidden = { status: 403 }
// Board hides unreadable messages as not found; writes are forbidden.
const hidden = { status: 404, code: 'message_not_found' }

function openBoard(t: TestContext, afterGrantRead?: () => Promise<void>) {
  const url = 'https://party-board.example.test'
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const principals = new Map(Object.entries(people).map(([handle, email], i) => [
    `fixture-${i}`, { id: principalOf(email).id, kind: 'person' as const, handle },
  ]))
  const host = board({ backend, url, authenticate: ({ credential }) => principals.get(credential ?? '') ?? null })

  // The public Node handle uses its HTTP backend at BOARD_URL. Replace only the
  // network hop; every request still goes through the host's real policy.
  const caller = new AsyncLocalStorage<string>()
  const env = { BOARD_URL: url, BOARD_TOKEN: 'fixture-transport' }
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key]
    process.env[key] = value
    t.after(() => {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    })
  }
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    assert.equal(new URL(request.url).origin, url)
    const token = caller.getStore()
    assert.ok(token)
    request.headers.set('authorization', `Bearer ${token}`)
    const response = await host.fetch(request)
    // Let a second writer change real grants after the board has taken the snapshot.
    if (request.method === 'GET' && new URL(request.url).pathname.endsWith('/grants')) await afterGrantRead?.()
    return response
  })
  return (who: keyof typeof people) => {
    const token = [...principals].find(([, principal]) => principal.handle === who)![0]
    const handle = board()
    return <T>(run: (board: Board) => T): T => caller.run(token, run, handle)
  }
}

test('repo grants isolate party channels, deny role escalation, revoke membership and detect drift', async (t) => {
  const as = openBoard(t)
  const jockey = as('jockey')
  const stranger = as('stranger')
  const posts = new Map<string, string>()
  const task = await jockey(async (b) => {
    for (const channel of channels) {
      await b.createChannel(channel)
      if (channel !== work) posts.set(channel, (await b.post(channel, channel)).id)
    }
    const { task } = await b.tasks.create(work, 'ready to claim')
    posts.set(work, task.id)
    return task
  })
  // The signed-in stranger had the starting access, not an invalid credential.
  assert.deepEqual(await stranger(paths), [...channels].sort())
  await jockey((b) => applyGrants(b, registry, repo))
  await stranger(async (b) => {
    for (const [channel, id] of posts) {
      await assert.rejects(b.thread(id), hidden, `stranger read ${channel}`)
      await assert.rejects(b.post(channel, 'not a member'), forbidden, `stranger posted in ${channel}`)
    }
  })

  const readerId = principalOf(people.redReader).userId
  const escalation = {
    principals: [{ kind: 'user' as const, userId: readerId }], can: { [work]: ['read', 'post'] },
  } satisfies Parameters<Board['createGrant']>[0]
  const { grant: project } = await jockey((b) => b.createGrant({
    principals: [{ kind: 'project', project: 'prj_fixture', environments: ['production'] }], can: { [work]: ['read'] },
  }))
  for (const { id, member, reader, other } of parties) {
    await as(member)(async (b) => {
      assert.deepEqual(await paths(b), [...shared, inbox(id)].sort())
      await b.post(inbox(id), 'own party mail')
      await assert.rejects(b.thread(posts.get(inbox(other))!), hidden)
      await assert.rejects(b.post(inbox(other), 'wrong party'), forbidden)
      await assert.rejects(b.createGrant(escalation), forbidden, 'member created a grant')
      await assert.rejects(b.updateGrant(project.id, { can: { [work]: 'all' } }), forbidden, 'member changed a grant')
      await assert.rejects(b.tasks.claim(task.id), forbidden, 'member claimed work')
      await assert.rejects(b.label(task.id, { set: { party: id } }), forbidden, 'member set labels')
    })
    await as(reader)(async (b) => {
      await b.thread(posts.get(inbox(id))!)
      for (const channel of channels) await assert.rejects(b.post(channel, 'reader post'), forbidden, channel)
    })
  }

  await jockey(async (b) => {
    assert.deepEqual(await paths(b), [...channels].sort())
    for (const [channel, id] of posts) {
      await b.thread(id)
      if (channel !== work) await b.post(channel, 'jockey can post')
    }
    await b.tasks.claim(task.id)
    const written = new Map<string, string>()
    for (const { id, other } of parties) {
      const writer = partyWriter(b, id)
      written.set((await writer.post(work, `work for ${id}`)).id, id)
      await assert.rejects(writer.post(work, 'wrong label', { labels: { party: other } }), /party label does not match/)
      await assert.rejects(writer.post(inbox(other), 'wrong channel'), /another party channel/)
    }
    const rows = (await b.threads({ channel: work })).threads.filter(({ message }) => message.id !== task.id)
    assert.deepEqual(new Map(rows.map(({ message }) => [message.id, message.labels?.party])), written)
    for (const { id } of parties) {
      const { threads } = await rowsOfParty(b, id, { channel: work })
      assert.deepEqual(threads.map(({ message }) => message.id), [...written].filter(([, party]) => party === id).map(([row]) => row))
    }

    assert.deepEqual(await auditGrants(b, registry, repo), { ok: true, violations: [] })
    const { grant: extra } = await b.createGrant(escalation)
    const { grant: everyone } = await b.createGrant({ principals: [{ kind: 'everyone' }], can: { '*': ['read'] } })
    const audit = await auditGrants(b, registry, repo)
    assert.equal(audit.ok, false)
    assert.ok(audit.violations.some((entry) => entry.includes(readerId)), 'audit missed excess user grant')
    assert.ok(audit.violations.some((entry) => entry.includes('everyone') && entry.includes('*')), 'audit missed everyone grant')
    await applyGrants(b, registry, repo)
    const grants = await b.grants()
    assert.ok(!grants.some(({ id }) => id === everyone.id), 'apply did not revoke the everyone grant')
    assert.ok(!grants.some(({ id }) => id === extra.id), 'apply did not revoke the extra user grant')
    assert.deepEqual(grants.find(({ id }) => id === project.id), project)
  })

  const removed = removeMember(registry, 'default', people.red)
  await jockey((b) => applyGrants(b, removed, repo))
  await as('red')(async (b) => {
    await assert.rejects(b.thread(task.id), hidden, 'removed member read work')
    await assert.rejects(b.post(work, 'removed member'), forbidden, 'removed member posted work')
  })
  await as('redReader')((b) => b.thread(posts.get(inbox('default'))!))
  await as('blueReader')((b) => b.thread(posts.get(inbox('blue'))!))
  await as('blue')((b) => b.post(work, 'still a member'))
  const downgraded = setMember(removed, 'blue', people.blue, 'reader')
  await jockey((b) => applyGrants(b, downgraded, repo))
  await as('blue')(async (b) => {
    await b.thread(task.id)
    await assert.rejects(b.post(work, 'now a reader'), forbidden)
  })
  assert.deepEqual(await jockey((b) => applyGrants(b, downgraded, repo)), { created: 0, updated: 0, revoked: 0 })
})

const projectPrincipal = { kind: 'project' as const, project: 'prj_fixture', environments: ['production'] }
const userPrincipal = (email: string) => ({ kind: 'user' as const, userId: principalOf(email).userId })

test('reconciling a mixed grant removes the former member without dropping the project or current member', async (t) => {
  const as = openBoard(t)
  const id = await as('jockey')(async (b) => {
    await b.createChannel(work)
    const message = await b.post(work, 'party work')
    const joined = setMember(registry, 'default', people.stranger, 'member')
    await applyGrants(b, joined, repo)
    const { grant } = await b.createGrant({
      principals: [projectPrincipal, userPrincipal(people.red), userPrincipal(people.stranger)],
      can: channelsFor('member', 'default', 'repo'),
    })
    await applyGrants(b, removeMember(joined, 'default', people.stranger), repo)
    const reconciled = (await b.grants()).find(({ id }) => id === grant.id)
    assert.deepEqual(reconciled?.principals, grant.principals.filter((p) =>
      p.kind !== 'user' || p.userId !== principalOf(people.stranger).userId))
    return message.id
  })
  await as('stranger')((b) => assert.rejects(b.thread(id), hidden))
})

test('reconciling keeps an everyone deny beside an allow and the audit flags widening', async (t) => {
  const as = openBoard(t)
  const closed = 'party/secret'
  const project = { project: 'prj_fixture', environment: 'production' } as const
  await as('jockey')(async (b) => {
    await b.createChannel(closed)
    await b.post(closed, 'sealed')
    await b.createGrant({ principals: [projectPrincipal], can: { '*': ['read'] } })
    await applyGrants(b, registry, repo)
    // Closer than everyone at the closed channel, so the operator can still change that grant.
    await b.createGrant({ principals: [userPrincipal(people.jockey)], can: { [closed]: 'all' } })
    const { grant } = await b.createGrant({
      principals: [{ kind: 'everyone' }],
      can: { '*': ['read'], [closed]: [] },
    })
    assert.deepEqual((await b.explain(closed, project)).can, [])
    const before = await b.grants()
    await b.revokeGrant(grant.id)
    assert.deepEqual((await b.explain(closed, project)).can, ['read'])
    const widened = await auditGrants(b, registry, repo, before)
    assert.equal(widened.ok, false, widened.violations.join('; '))
    assert.ok(
      widened.violations.some((entry) => entry.includes('prj_fixture') && entry.includes(closed) && entry.includes('gained')),
      widened.violations.join('; '),
    )
    await b.createGrant({ principals: [{ kind: 'everyone' }], can: { '*': ['read'], [closed]: [] } })
    await applyGrants(b, registry, repo)
    assert.deepEqual((await b.explain(closed, project)).can, [])
    const kept = (await b.grants()).find((row) => row.principals.some((principal) => principal.kind === 'everyone'))
    assert.deepEqual(kept?.can, { [closed]: [] })
  })
})

test('reconciling an edited starting grant strips broad principals without dropping the project', async (t) => {
  await openBoard(t)('jockey')(async (b) => {
    const { grant } = await b.updateGrant('g1', {
      add: [projectPrincipal, { kind: 'everyone' }],
    })
    await applyGrants(b, registry, repo)
    const retained = (await b.grants()).find(({ id }) => id === grant.id)
    assert.deepEqual(retained && { principals: retained.principals, can: retained.can }, {
      principals: grant.principals.filter((p) => p.kind === 'project'), can: grant.can,
    })
  })
})

const grantShape = (grants: Awaited<ReturnType<Board['grants']>>) => grants.map(({ principals, can }) => ({
  principals: principals.map((principal) => JSON.stringify(principal)).sort(),
  can,
})).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))

test('apply reports excess grants added after it read the initial grants', async (t) => {
  let inject = false
  const jockey = openBoard(t, async () => {
    if (!inject) return
    inject = false
    await jockey((b) => b.createGrant({
      principals: [{ kind: 'everyone' }, userPrincipal(people.stranger)], can: { '*': ['read'] },
    }))
  })('jockey')
  await jockey((b) => applyGrants(b, registry, repo))
  const before = await jockey((b) => b.grants())
  inject = true
  await jockey((b) => assert.rejects(applyGrants(b, registry, repo), {
    message: `cannot apply grants: everyone grants access at *; ${principalOf(people.stranger).userId} exceeds registry membership at *`,
  }))
  assert.deepEqual(await jockey((b) => b.grants()), before)
})

test('adding a member grants the channels they were given and a second apply writes nothing', async (t) => {
  const as = openBoard(t)
  const joined = setMember(registry, 'default', people.stranger, 'member')
  const posted = await as('jockey')(async (b) => {
    await b.createChannel('intake')
    const message = await b.post('intake', 'open')
    await applyGrants(b, registry, repo)
    await as('stranger')((board) => assert.rejects(board.thread(message.id), hidden))
    assert.deepEqual(await applyGrants(b, joined, repo), { created: 0, updated: 1, revoked: 0 })
    assert.deepEqual(await applyGrants(b, joined, repo), { created: 0, updated: 0, revoked: 0 })
    return message.id
  })
  await as('stranger')((b) => b.post('intake', 'joined'))
  await as('stranger')((b) => b.thread(posted))
})

test('an unrequested widening is refused and a retry still sees the previous grants', async (t) => {
  let inject = false
  const as = openBoard(t, async () => {
    if (!inject) return
    inject = false
    await as('jockey')((b) => b.createGrant({
      principals: [projectPrincipal], can: { 'party/secret': ['read'] },
    }))
  })
  const joined = setMember(registry, 'default', people.stranger, 'member')
  const posted = await as('jockey')(async (b) => {
    await b.createChannel('intake')
    await b.createChannel('party/secret')
    const message = await b.post('intake', 'open')
    await applyGrants(b, registry, repo)
    const before = await b.grants()
    inject = true
    await assert.rejects(applyGrants(b, joined, repo), (error: Error) => {
      assert.match(error.message, /gained read at party\/secret/)
      assert.doesNotMatch(error.message, /gained post at intake/)
      return true
    })
    assert.deepEqual(grantShape(await b.grants()), grantShape(before))
    await as('stranger')((board) => assert.rejects(board.thread(message.id), hidden))
    const retry = await applyGrants(b, joined, repo)
    assert.notDeepEqual(retry, { created: 0, updated: 0, revoked: 0 })
    assert.deepEqual(await applyGrants(b, joined, repo), { created: 0, updated: 0, revoked: 0 })
    return message.id
  })
  await as('stranger')((b) => b.thread(posted))
  await as('stranger')((b) => b.post('intake', 'joined after the refused pass'))
})

test('dropping a deny on a channel the member grants do not name is refused and a retry still sees it', async (t) => {
  let inject = false
  let denyId = ''
  const as = openBoard(t, async () => {
    if (!inject) return
    inject = false
    await as('jockey')((b) => b.revokeGrant(denyId))
  })
  const secret = 'work/secret'
  await as('jockey')(async (b) => {
    await b.createChannel(secret)
    const message = await b.post(secret, 'sealed')
    await applyGrants(b, registry, repo)
    await as('red')((board) => board.thread(message.id))
    // Same pattern as the deny, so the operator can still change it. The member grant names work/, not this channel.
    await b.createGrant({ principals: [userPrincipal(people.jockey)], can: { [secret]: 'all' } })
    denyId = (await b.createGrant({ principals: [{ kind: 'everyone' }], can: { [secret]: [] } })).grant.id
    await as('red')((board) => assert.rejects(board.thread(message.id), hidden))
    const before = await b.grants()
    inject = true
    await assert.rejects(applyGrants(b, registry, repo), (error: Error) => {
      assert.match(error.message, new RegExp(`gained read at ${secret}`))
      assert.doesNotMatch(error.message, /not restored/)
      return true
    })
    assert.deepEqual(grantShape(await b.grants()), grantShape(before))
    await as('red')((board) => assert.rejects(board.thread(message.id), hidden))
    await applyGrants(b, registry, repo)
    await as('red')((board) => assert.rejects(board.thread(message.id), hidden))
    assert.equal((await b.grants()).some((grant) => grant.principals.some((principal) => principal.kind === 'everyone') && secret in grant.can), true)
    assert.deepEqual(await applyGrants(b, registry, repo), { created: 0, updated: 0, revoked: 0 })
  })
})

test('a refused apply restores an invitee principal and revokes a widening grant from that pass', async (t) => {
  let inject = false
  let inviteeGrant = ''
  const as = openBoard(t, async () => {
    if (!inject) return
    inject = false
    await as('jockey')(async (b) => {
      await b.revokeGrant(inviteeGrant)
      await b.createGrant({ principals: [projectPrincipal], can: { 'party/secret': ['read'] } })
    })
  })
  await as('jockey')(async (b) => {
    await applyGrants(b, registry, repo)
    const { secret } = await b.createInvite({ name: 'guest', can: { intake: ['read'] } })
    const { principal } = await b.join(secret)
    inviteeGrant = (await b.grants()).find((grant) => grant.principals.some((one) => one.kind === 'invitee' && one.id === principal))!.id
    const before = await b.grants()
    inject = true
    await assert.rejects(applyGrants(b, registry, repo), (error: Error) => {
      assert.match(error.message, /gained read at party\/secret/)
      assert.doesNotMatch(error.message, /not restored/)
      return true
    })
    const after = await b.grants()
    assert.deepEqual(grantShape(after), grantShape(before))
    assert.equal(after.some((grant) => grant.principals.some((one) => one.kind === 'invitee' && one.id === principal)), true)
    assert.equal(after.some((grant) => Object.hasOwn(grant.can, 'party/secret')), false)
    assert.deepEqual(await applyGrants(b, registry, repo), { created: 0, updated: 0, revoked: 0 })
    assert.deepEqual(grantShape(await b.grants()), grantShape(before))
  })
})

test('reconciling a deleted party board revokes former members’ access', async (t) => {
  const as = openBoard(t)
  const options = { kind: 'party', party: 'default' } as const
  const id = await as('jockey')(async (b) => {
    await b.createChannel('inbox')
    await applyGrants(b, registry, options)
    return (await b.post('inbox', 'party mail')).id
  })
  await as('red')((b) => b.thread(id))
  const removed = removeParty(registry, options.party)
  await as('jockey')(async (b) => {
    await assert.rejects(applyGrants(b, removed, { ...options, party: 'default/inbox' }), RegistryError)
    await applyGrants(b, removed, options)
    await b.thread(id)
  })
  await as('red')((b) => assert.rejects(b.thread(id), hidden))
})

for (const role of ['member', 'jockey'] as const) {
  test(`apply rejects 33 ${role} principals before writing any grants`, async (t) => {
    const emails = [people.jockey, ...Array.from({ length: 32 }, (_, i) => `person-${i}@example.test`)]
    const oversized: Registry = role === 'jockey' ? { ...registry, jockeys: emails } : {
      ...registry, parties: [{ ...registry.parties[0]!, members: [...emails.slice(1), people.red].map((email) => ({ email, role })) }],
    }
    await openBoard(t)('jockey')(async (b) => {
      const before = await b.grants()
      await assert.rejects(applyGrants(b, oversized, { kind: 'party', party: 'default' }), {
        name: 'RegistryError', message: `default ${role}: board limit is 32 principals`,
      })
      assert.deepEqual(await b.grants(), before)
    })
  })
}

test('record attribution uses the channel, then label, then unambiguous membership', async (t) => {
  const as = openBoard(t)
  const multi = setMember(registry, 'default', people.blue, 'member')
  const jockeyMember = setMember(multi, 'blue', people.jockey, 'member')
  const { conflicting, stamped, unlabeled } = await as('jockey')(async (b) => {
    await b.createChannel('intake')
    await b.createChannel(inbox('default'))
    await applyGrants(b, jockeyMember, repo)
    return {
      conflicting: await b.post(inbox('default'), { text: 'conflicting label', labels: { party: 'blue' } }),
      stamped: await partyWriter(b, 'blue').post('intake', 'dispatched record'),
      unlabeled: await b.post('intake', 'unstamped jockey post'),
    }
  })
  const plain = await as('red')((b) => b.post('intake', 'plain member post'))
  const ambiguous = await as('blue')((b) => b.post('intake', 'ambiguous member post'))
  const mail = await as('blue')((b) => b.post(inbox('default'), 'plain member mail'))
  assert.equal(partyOfRecord(plain, jockeyMember), 'default')
  assert.equal(partyOfRecord(ambiguous, jockeyMember), null)
  assert.equal(partyOfRecord(mail, jockeyMember), 'default')
  assert.equal(partyOfRecord(conflicting, jockeyMember), null)
  assert.equal(partyOfRecord(stamped, jockeyMember), 'blue')
  assert.equal(partyOfRecord(unlabeled, jockeyMember), null)
})

test('apply surfaces the board lockout refusal and leaves the operator in control', async (t) => {
  await openBoard(t)('jockey')(async (b) => {
    await applyGrants(b, registry, repo)
    const grants = await b.grants()
    await assert.rejects(applyGrants(b, { ...registry, jockeys: [] }, repo), /operator must be a registry jockey/)
    assert.deepEqual(await b.grants(), grants)
  })
})
