import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { http } from '../src/backend-http/index.ts'
import { board } from '../src/server/index.ts'
import { bearer, localBoard, localUserToken } from './harness.ts'
import { serve } from './http.ts'

type Run = { code: number; stdout: string; stderr: string }
type Post = { message: { id: string; text: string; by: { actor: string }; author: { name: string } } }
type Me = { actor: string; handle: string; board: string; can: Record<string, string[]>; source: string }
type Invite = { id: string; name: string; expiresAt: string; can: Record<string, string[]>; state: string }
type Failure = { reason?: string; data?: { error?: { status?: number } } }

const CLI = join(import.meta.dirname, '../src/cli/bin.ts')
const CREDENTIAL = /vb[ij]_[\w-]{43}/
const SCOPE = { 'handoff/': ['read', 'post'] }
const TIMEOUT = 30_000

/** Report the action, never an exception (e.g. JSON parse or subprocess error) that might quote its input. */
async function privateResult<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch {
    throw new Error(`${label} failed`)
  }
}

function parse<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${label} did not return JSON`)
  }
}

function success<T>(output: Run, label: string): T {
  expect(output.code, label).toBe(0)
  return parse<T>(output.stdout, label)
}

function publicJson<T extends object>(output: Run, label: string): T {
  const value = success<T>(output, label)
  const sensitiveKeys: string[] = []
  JSON.stringify(value, (key, entry: unknown) => {
    if (key === 'token' || key === 'secret') sensitiveKeys.push(key)
    return entry
  })
  expect(sensitiveKeys.length === 0, `${label} returns only public metadata`).toBe(true)
  return value
}

function refused(output: Run, label: string, expected: number | string) {
  expect(output.code, label).toBe(1)
  const error = parse<Failure>(output.stderr, label)
  const actual = typeof expected === 'number' ? error.data?.error?.status : error.reason
  expect(actual === expected, `${label} reports ${expected}`).toBe(true)
}

async function setup(onTestFinished: (cleanup: () => Promise<void>) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'board-invite-test-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, '.git'))
  const local = localBoard({ url: undefined })
  onTestFinished(() => local.close())
  const server = await serve(local.fetch)
  onTestFinished(() => server.close())
  const url = `${server.origin}/api/board`
  const adminToken = await localUserToken('board-admin', url)
  type Role = 'admin' | 'invitee' | 'second-invitee'
  const homes = new Map<Role, string>()

  async function cli(role: Role, label: string, args: string[], stdin?: string) {
    let home = homes.get(role)
    if (!home) {
      home = await mkdtemp(join(dir, `${role}-`))
      homes.set(role, home)
    }
    const output = await new Promise<Run>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        cwd: dir,
        // Don't use the running user's environment, Vercel login, or local owner token file.
        env: {
          HOME: home,
          PATH: '',
          XDG_CONFIG_HOME: join(home, 'config'),
          XDG_DATA_HOME: join(home, 'data'),
          ...(role === 'admin' ? { BOARD_TOKEN: adminToken } : {}),
        },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
      child.on('error', () => reject(new Error(`${label}: vb could not start`)))
      // A command that exits without reading stdin can close the pipe first.
      child.stdin.on('error', () => {})
      child.stdin.end(stdin)
    })
    const printed = output.stdout + output.stderr
    expect(CREDENTIAL.test(printed) || printed.includes(adminToken), `${label} printed a credential`).toBe(false)
    return output
  }

  const admin = (label: string, ...args: string[]) => cli('admin', label, ['--url', url, ...args, '--json'])
  const guest = (label: string, ...args: string[]) => cli('invitee', label, ['--url', url, ...args, '--json'])

  async function create(name: string, ...options: string[]) {
    const path = join(dir, `${name}.invite`)
    const { invite } = publicJson<{ invite: Invite }>(await admin('create invite', 'invite', 'create', name, '--out', path, ...options), 'create invite')
    expect(typeof invite?.id === 'string' && invite.id.length > 0, 'create reports a public ID').toBe(true)
    const text = await readFile(path, 'utf8')
    expect(/^vbi_[\w-]{43}\n$/.test(text), 'invite file contains one credential and newline').toBe(true)
    expect((await stat(path)).mode & 0o777, 'invite file permissions').toBe(0o600)
    expect(invite.id === text.trim(), 'public ID is not the credential').toBe(false)
    return { invite, text }
  }

  async function list() {
    const { invites } = publicJson<{ invites: Invite[] }>(await admin('list invites', 'invite', 'list'), 'list invites')
    expect(Array.isArray(invites), 'list reports invite metadata').toBe(true)
    return invites
  }

  return { cli, admin, guest, create, list, dir, url, adminToken }
}

it('joins once and uses the saved invitee identity and scoped access in new CLI processes', async ({ onTestFinished }) => {
  const { cli, admin, guest, create, list, dir, url } = await setup(onTestFinished)
  const visible = success<Post>(await admin('seed visible thread', 'post', 'handoff/inbox', 'welcome'), 'seed visible thread').message.id
  const hidden = success<Post>(await admin('seed hidden thread', 'post', 'handoff-other/inbox', 'not shared'), 'seed hidden thread').message.id
  const { invite, text } = await create('new-member', '--expires-in', '120', '--can', 'handoff/=read,post')
  expect(invite.name === 'new-member' && invite.state === 'pending', 'new invite metadata').toBe(true)
  expect(JSON.stringify(invite.can) === JSON.stringify(SCOPE), 'create reports the requested access').toBe(true)
  expect((await list()).some((entry) => entry.id === invite.id && entry.state === 'pending'), 'admin lists the pending invite').toBe(true)

  const joined = publicJson<{ principal: string }>(await cli('invitee', 'join from stdin', ['join', url, '-', '--json'], text), 'join from stdin')
  const me = success<Me>(await guest('invitee whoami', 'whoami'), 'invitee whoami')
  expect(typeof me.actor === 'string' && me.actor.length > 0 && me.actor === joined.principal, 'whoami reports the joined actor').toBe(true)
  expect(me.handle === 'new-member', 'whoami reports the invited name').toBe(true)
  expect(me.board === url && me.source === 'vb join', 'whoami reports the board and saved credential source').toBe(true)
  expect(JSON.stringify(me.can) === JSON.stringify(SCOPE), 'whoami reports the scoped access').toBe(true)

  const read = success<Post>(await guest('read allowed thread', 'read', visible), 'read allowed thread')
  expect(read.message?.text === 'welcome', 'invitee reads the thread in scope').toBe(true)
  refused(await guest('read hidden thread', 'read', hidden), 'read hidden thread', 404)
  const post = success<Post>(await guest('post in scope', 'post', 'handoff/inbox', 'first day'), 'post in scope')
  const saved = success<Post>(await admin('read the invitee post', 'read', post.message.id), 'read the invitee post')
  expect(saved.message?.by.actor === me.actor && saved.message?.text === 'first day', 'board attributes the saved post to the invitee').toBe(true)
  refused(await guest('post outside scope', 'post', 'handoff-other/inbox', 'not allowed'), 'post outside scope', 403)
  refused(await guest('invitee mints invite', 'invite', 'create', 'another-member', '--out', join(dir, 'unauthorized.invite')), 'invitee mints invite', 'permission_denied')

  refused(await cli('second-invitee', 'reuse invite', ['join', url, text.trim(), '--json']), 'reuse invite', 'invalid_invite')
  expect((await list()).some((entry) => entry.id === invite.id && entry.state === 'redeemed'), 'admin lists the redeemed invite').toBe(true)
}, TIMEOUT)

it('lists revoked and expired invites and refuses to join using either one', async ({ onTestFinished }) => {
  const { cli, admin, guest, create, list, url } = await setup(onTestFinished)
  const revoked = await create('revoked-member')
  const changed = success<{ revoked: boolean }>(await admin('revoke invite', 'invite', 'revoke', revoked.invite.id), 'revoke invite')
  expect(changed.revoked === true, 'admin revoked the invite by public ID').toBe(true)
  refused(await cli('invitee', 'join with revoked invite', ['join', url, revoked.text.trim(), '--json']), 'join with revoked invite', 'invalid_invite')

  const before = Date.now()
  const expiring = await create('expired-member', '--expires-in', '1')
  const expiresAt = Date.parse(expiring.invite.expiresAt)
  expect(expiresAt >= before + 1_000 && expiresAt <= Date.now() + 1_000, 'create reports the short expiry').toBe(true)
  // Wait for the reported expiry, not for a guess at how long the CLI took to start.
  await delay(Math.max(0, expiresAt - Date.now()) + 10)
  refused(await cli('invitee', 'join with expired invite', ['join', url, '-', '--json'], expiring.text), 'join with expired invite', 'invalid_invite')
  const listed = await list()
  expect(listed.some((entry) => entry.id === revoked.invite.id && entry.state === 'revoked'), 'admin lists the revoked invite').toBe(true)
  expect(listed.some((entry) => entry.id === expiring.invite.id && entry.state === 'expired'), 'admin lists the expired invite').toBe(true)

  const fresh = await create('argv-member')
  expect((await cli('invitee', 'join from argv', ['join', url, fresh.text.trim()])).code, 'join from argv').toBe(0)
  const me = success<Me>(await guest('argv invitee whoami', 'whoami'), 'argv invitee whoami')
  expect(me.handle === 'argv-member', 'a fresh invite joins as its named member').toBe(true)
}, TIMEOUT)

it('redeems through the SDK and records the verified HTTP author, not the submitted one', async ({ onTestFinished }) => {
  const { url, adminToken } = await setup(onTestFinished)
  const admin = board({ backend: http(url, { fetch: bearer(fetch, adminToken) }) }).as(null)
  const stranger = board({ backend: http(url, { fetch }) }).as(null)
  const created = await privateResult('SDK create invite', () => admin.createInvite({ name: 'sdk-member' }))
  expect(/^vbi_[\w-]{43}$/.test(created.secret), 'SDK returns an invite credential').toBe(true)
  const joined = await privateResult('SDK join', () => stranger.join(created.secret))
  expect(/^vbj_[\w-]{43}$/.test(joined.token), 'SDK returns a new session credential').toBe(true)
  const invites = await privateResult('SDK list invites', () => admin.invites())
  expect(invites.some((entry) => entry.id === created.invite.id && entry.state === 'redeemed'), 'SDK lists the correct public ID as redeemed').toBe(true)

  const posted = await privateResult('HTTP post as the invitee', () => fetch(`${url}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${joined.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      channel: 'handoff/inbox',
      text: 'sent as the invitee',
      by: { actor: 'local:user:board-admin' },
      author: { name: 'board-admin' },
    }),
  }))
  expect(posted.status).toBe(201)
  const { message } = await privateResult('read HTTP post response', () => posted.json() as Promise<Post>)
  expect(message?.by?.actor === joined.principal && message?.author?.name === 'sdk-member', 'server sets the author from the verified credential').toBe(true)
}, TIMEOUT)
