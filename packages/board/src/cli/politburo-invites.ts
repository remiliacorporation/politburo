import { open, unlink } from 'node:fs/promises'
import { CreateInviteBody, type InviteView } from '../api/routes.ts'
import { BoardError } from '../client/client.ts'
import { canonicalJoinUrl, INVITE_SECRET, JOIN_TOKEN, prepareJoinCredential } from '../client/join-config.ts'
import { JOINED, redeemFetch } from '../client/node.ts'
import { http } from '../backend-http/index.ts'
import { board as boardAt, type Board } from '../server/index.ts'
import { conformance } from '../conformance/index.ts'
import type { Failure } from './failure.ts'
import { formatConformance, grantCan } from './format.ts'
import { grantCanOf } from './grants.ts'
import { client, connection, current, doing, Failed, flags, io, out, result, sent, usage, vercelBoard } from './main.ts'

/** Public metadata (an invite name, a principal, a channel) must not echo a credential. */
export const redactCredentials = (text: string) => text.replace(/vb[ij]_[A-Za-z0-9_-]{43}/g, '[redacted]')
const privateOutput = () => current.command === 'invite' || current.command === 'join' || sent() === JOINED
export const outputText = (text: string) => privateOutput() ? redactCredentials(text) : text

/** The conformance invitee talks only to this mount, with the new bearer and no other credentials. */
function inviteMember(at: string, token: string): Board {
  const mount = new URL(at)
  const path = mount.pathname.replace(/\/+$/, '')
  const send: typeof fetch = async (input, init) => {
    const request = new Request(input, { ...init, credentials: 'omit', redirect: 'error' })
    const to = new URL(request.url)
    if (to.origin !== mount.origin || (to.pathname !== path && !to.pathname.startsWith(`${path}/`)))
      throw new Error('Joined conformance requests must stay on the board that issued the invite.')
    request.headers.set('authorization', `Bearer ${token}`)
    return globalThis.fetch(request)
  }
  return boardAt({ backend: http(at, { fetch: send }) }).as(null)
}

/** Never include the board's message, hint, code, or response body from an invite operation. */
export function inviteFailure(error: unknown): Failure {
  const status = error instanceof BoardError ? error.status : undefined
  if (current.command === 'join') {
    if (status === 400 || status === 401 || status === 403 || status === 410)
      return { class: 'auth', reason: 'invalid_invite', message: "The board didn't accept the invite.", next: [{ instruction: 'Check the board URL or ask for a new invite' }] }
    if (status === 404 || status === 405 || status === 501)
      return { class: 'platform', reason: 'invites_unavailable', message: "This URL doesn't accept invites." }
    return { class: 'network', reason: 'join_failed', message: "Couldn't join the board at that URL.", next: [{ instruction: 'Check the URL, including its path; join does not follow redirects' }] }
  }
  const action = doing()
  if (status === 401 || status === 403) return { class: 'permission', reason: 'permission_denied', message: `You can't ${action}.`, next: [{ instruction: 'Use a credential with board-wide manage access' }] }
  if (status === 501) return { class: 'platform', reason: 'invites_unavailable', message: "This board doesn't manage invites." }
  if (status === 400) return { class: 'usage', reason: 'invalid_invite_arguments', message: `The board rejected the request to ${action}.` }
  return {
    class: 'platform', reason: 'invite_request_failed', message: `Couldn't ${action}.`,
    ...(current.args[0] === 'create' ? { next: [{ instruction: 'Check the invite list before trying again' }] } : {}),
  }
}

/** A view is public metadata, even if a remote included additional fields in its answer. */
const inviteView = ({ id, name, can, expiresAt, state }: InviteView): InviteView => ({ id, name, can, expiresAt, state })
const inviteRow = ({ id, name, state, expiresAt, can }: InviteView) => `${id}  ${name}  ${state}  ${expiresAt}  ${grantCan(can, false)}`.trimEnd()

export async function runInvite([verb, subject, extra]: string[]): Promise<number> {
  if (verb !== 'create' && verb !== 'list' && verb !== 'revoke') throw usage('Use invite create, invite list, or invite revoke.')
  if (verb !== 'create' && (flags.out !== undefined || flags['expires-in'] !== undefined || flags.can !== undefined))
    throw usage('--out, --expires-in, and --can are for invite create.')
  if (verb === 'list') {
    if (subject !== undefined) throw usage('invite list takes no arguments.')
    const invites = (await client().invites()).map(inviteView)
    if (flags.json) result({ invites })
    else out(invites.length ? invites.map(inviteRow).join('\n') : 'no invites')
    return 0
  }
  if (verb === 'revoke') {
    if (!subject || extra !== undefined || !/^[^\s/]+$/.test(subject)) throw usage('invite revoke takes one invite ID, from invite list.')
    const { revoked } = await client().revokeInvite(subject)
    if (flags.json) result({ revoked })
    else out(`${revoked ? 'revoked' : 'not revoked'} ${subject}`)
    return 0
  }
  if (io.board) throw usage('invite create needs a private file on this machine.', { reason: 'not_available', next: [] })
  if (extra !== undefined || !CreateInviteBody.shape.name.safeParse(subject).success)
    throw usage('Pass one name: a letter, then up to 31 letters, digits, or hyphens.')
  const path = flags.out
  if (!path || path === '-') throw usage('Pass --out <file> to save the invite secret to a new private file.', { reason: 'missing_arguments' })
  const expires = flags['expires-in']
  if (expires !== undefined && !/^\d{1,6}$/.test(expires)) throw usage('--expires-in takes whole seconds from 1 to 604800.')
  const expiresIn = expires === undefined ? undefined : Number(expires)
  if (!CreateInviteBody.shape.expiresIn.safeParse(expiresIn).success) throw usage('--expires-in takes whole seconds from 1 to 604800.')
  let can
  try {
    can = flags.can === undefined ? undefined : grantCanOf(flags.can)
  } catch {
    throw usage('--can takes pattern=permissions, like support/=read,post.')
  }
  const input = CreateInviteBody.safeParse({ name: subject, expiresIn, can })
  if (!input.success) throw usage('--can takes read, post, react, label, or sync. Invites cannot grant all or manage.')

  const board = client()
  // Reserve the file first: if it exists or can't be opened, no invite is made.
  const file = await open(path, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw usage('--out already exists. Pick a new file.', { reason: 'file_exists' })
    throw new Failed({ class: 'platform', reason: 'invite_file_error', message: "Couldn't open the invite file." })
  })
  let created: InviteView | undefined
  try {
    await file.chmod(0o600).catch(() => {
      throw new Failed({ class: 'platform', reason: 'invite_file_error', message: "Couldn't make the invite file private." })
    })
    const { invite, secret } = await board.createInvite(input.data)
    created = invite
    if (typeof secret !== 'string' || !INVITE_SECRET.test(secret)) throw new Error('invalid invite response')
    await file.writeFile(`${secret}\n`, 'utf8')
    await file.close()
  } catch (error) {
    await file.close().catch(() => {})
    await unlink(path).catch(() => {})
    if (!created) throw error
    const revoked = await board.revokeInvite(created.id).then(({ revoked }) => revoked, () => false)
    throw new Failed({
      class: 'platform', reason: 'invite_file_error',
      message: revoked ? "Couldn't save the invite secret. The invite was revoked." : "Couldn't save the invite secret or confirm the invite was revoked.",
      ...(!revoked ? { next: [{ instruction: 'Check the invite list and revoke any pending invite you just made' }] } : {}),
    })
  }
  if (flags.json) result({ invite: inviteView(created), outcome: 'created' })
  else {
    out(`created ${inviteRow(created)}`)
    out(`file  ${path}`)
  }
  return 0
}

export async function runJoin([given, invite, extra]: string[]): Promise<number> {
  if (given === undefined || invite === undefined || extra !== undefined) throw usage('Pass a board URL and one invite, or - to read it from stdin.')
  if (flags.url !== undefined || flags.scope !== undefined || flags.team !== undefined || flags.name !== undefined || flags.ensure || flags.as !== undefined || flags.avatar !== undefined)
    throw usage('join takes the board URL as an argument, without board or profile options.')
  const url = canonicalJoinUrl(given)
  if (!url) throw usage('Use an HTTPS board URL without userinfo, query, or fragment. HTTP is only allowed on loopback.', { reason: 'invalid_board_url' })
  if (invite === '-' && process.stdin.isTTY) throw usage('Redirect stdin from the invite file when passing -.', { reason: 'missing_invite' })
  const secret = invite === '-' ? (await io.stdin()).trim() : invite
  if (!INVITE_SECRET.test(secret)) throw usage('Expected an invite secret, or - to read it from stdin.', { reason: 'invalid_invite' })

  const staged = await prepareJoinCredential(url).catch(() => {
    throw new Failed({ class: 'platform', reason: 'join_config_error', message: "Couldn't prepare a private file for the board credential." })
  })
  try {
    // This handle deliberately doesn't use connection(): no existing credentials or platform login.
    const board = boardAt({ backend: http(url, { fetch: redeemFetch }) })
    const { principal, token } = await board.join(secret)
    if (typeof principal !== 'string' || !principal || typeof token !== 'string' || !JOIN_TOKEN.test(token))
      throw new Failed({ class: 'platform', reason: 'invalid_join_response', message: "The board didn't return a valid credential." })
    await staged.save(token).catch(() => {
      throw new Failed({
        class: 'platform', reason: 'join_config_error', message: "The invite was redeemed, but the credential couldn't be saved.",
        next: [{ instruction: 'Fix the CLI config directory and ask for a new invite' }],
      })
    })
    if (flags.json) result({ board: url, principal })
    else {
      out(`joined ${principal}`)
      out(`board  ${url}`)
    }
  } finally {
    await staged.discard()
  }
  return 0
}

export async function checkConformance(): Promise<number> {
  // The same board with this run's own credential and headers of the run's (x-board-can, a profile), as a proxy holding it sends them:
  // what `vb()` was handed can't be opened again.
  const connected = io.board ? null : connection()
  const board = connected?.board ?? client()
  const at = connected?.url
  // Use the URL this run opened, not a URL from discovery or an injected handle we can't reopen.
  const mount = at && !vercelBoard(at) ? canonicalJoinUrl(at) : null
  // Open the board first: one it can't reach (no room for it, no grant, a lapsed login) is this run's error, not a check the board failed.
  await board.me()
  const report = await conformance(board, {
    ...(flags.channel ? { channel: flags.channel } : {}),
    ...(connected ? { withHeaders: (headers: Record<string, string>) => connection(undefined, { headers }).board } : {}),
    ...(mount ? { withInviteToken: (token: string) => inviteMember(mount, token) } : {}),
  })
  if (flags.json) result(report)
  else out(formatConformance(report))
  return report.ok ? 0 : 1
}
