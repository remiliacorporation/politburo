import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'experimental-a2/server'
import { describe, expect, it, vi } from 'vitest'
import { oidcTokens } from '../src/access/index.ts'
import { local } from '../src/backend-local/index.ts'
import { vb } from '../src/cli/embedded.ts'
import { ACCESS_SESSION, accessContract } from '../src/contract/contract.ts'
import { createHttp } from '../src/server/backend-http.ts'
import { sqlite } from '../src/store/sqlite.ts'
import type { BoardStore } from '../src/store/types.ts'
import { bearer, board, BOARD_URL, caller, deploymentToken, oidcToken, OIDC_ISS, personToken, PROJECT_ID, testAuth, testBoard, workflowToken } from './harness.ts'

const subject = (sub: string | string[]) => ({ kind: 'oidc' as const, issuer: OIDC_ISS, claims: { sub } })
const old = 'tenant/release/*'
const accessLog = (store: BoardStore) => createServer({ contract: accessContract, store: store.log }).session(ACCESS_SESSION)

// Seed events an older board could write. In particular, never open the board or use its
// current create route to make a legacy grant.
const stored = (sub: string | string[]) => ({
  type: 'grant.created' as const,
  payload: { principals: [subject(sub)], can: { ci: ['read', 'post'] }, by: 'vercel:user:u_previous' },
})

const reviewError = { status: 403, body: { error: { code: 'oidc_star_review_required', message: expect.stringContaining('vb grants acknowledge <id>') } } }
const check = (response: unknown) => expect(response).toMatchObject(reviewError)
const callAs = async (team: { fetch: (request: Request) => Promise<Response> }, token: Promise<string>, headers?: Record<string, string>) =>
  caller(team.fetch, await token, headers)
const handleAs = async (team: { fetch: (request: Request) => Promise<Response> }, token: Promise<string>) =>
  board({ backend: createHttp(BOARD_URL, { fetch: bearer((input, init) => team.fetch(new Request(input, init)), await token) }, null) })

describe('stored OIDC subject review', () => {
  it('refuses every grant-dependent caller without running its write, but keeps member and own deployment access', async ({ onTestFinished }) => {
    vi.stubEnv('VERCEL_TARGET_ENV', 'production')
    onTestFinished(() => { vi.unstubAllEnvs() })
    const screened: string[] = []
    const team = testBoard({ middleware: [({ write, next }) => { screened.push(write.text); return next() }] })
    await accessLog(team.store).append(
      stored(old),
      { type: 'grant.created', payload: { principals: [{ kind: 'github', repository: 'acme/web' }], can: { ci: ['post'] }, by: 'vercel:user:u_previous' } },
      { type: 'grant.created', payload: { principals: [{ kind: 'everyone' }], can: { private: [] }, by: 'vercel:user:u_previous' } },
    )
    const oidc = await callAs(team, oidcToken({ sub: old }))
    const github = await callAs(team, workflowToken())
    const otherDeployment = await callAs(team, deploymentToken())
    const ownDeployment = await callAs(team, deploymentToken('board', PROJECT_ID))
    const person = await callAs(team, personToken())
    for (const dependent of [oidc, github, otherDeployment]) {
      check(await dependent('POST', '/messages', { channel: 'ci', text: 'refused write' }))
      check(await dependent('GET', '/events'))
    }
    expect(screened).toEqual([])
    check(await person('GET', `/grants/explain?channel=ci&oidc=${encodeURIComponent(OIDC_ISS)}&claim=${encodeURIComponent(`sub=${old}`)}`))
    expect((await ownDeployment('POST', '/messages', { channel: 'private', text: 'from the board deployment' })).status).toBe(201)
    expect((await person('POST', '/messages', { channel: 'private', text: 'the member is still scoped by grants' })).status).toBe(403)
    expect((await person('POST', '/messages', { channel: 'ci', text: 'from the member' })).status).toBe(201)
    expect(screened).toEqual(['from the board deployment', 'from the member'])
    const { secret } = await team.createInvite({ name: 'guest', can: { ci: ['read'] } })
    const { token } = await team.join(secret)
    check(await caller(team.fetch, token)('GET', '/me'))
  })

  it('reviews a stored array subject once across concurrent opens and replays the verified acknowledgement', async ({ onTestFinished }) => {
    const dir = await mkdtemp(join(tmpdir(), 'board-oidc-review-'))
    const backends: ReturnType<typeof local>[] = []
    onTestFinished(async () => {
      await Promise.all(backends.map((backend) => backend.close()))
      await rm(dir, { recursive: true, force: true })
    })
    const path = join(dir, 'local.db')
    const store = sqlite({ path })
    const grant = stored(['tenant/pinned', old])
    const [, updated] = await accessLog(store).append(
      { ...grant, payload: { ...grant.payload, principals: [subject('tenant/pinned')] } },
      { type: 'grant.updated', payload: { ...grant.payload, id: 4 } },
    ).finally(() => store.close())
    const open = () => {
      const backend = local({ dir })
      backends.push(backend)
      return { backend, fetch: board({ backend, url: BOARD_URL, authenticate: oidcTokens(testAuth) }).fetch }
    }
    const first = open()
    const second = open()
    const credential = oidcToken({ sub: 'tenant/release/preview' })
    const read = (team: ReturnType<typeof open>) => callAs(team, credential).then((as) => as('GET', '/me'))
    for (const result of await Promise.all([read(first), read(second)])) check(result)
    await first.backend.close()
    const recovering = open()
    check(await read(recovering))
    const operator = await handleAs(recovering, personToken('u_reviewer'))
    const refused = await vb(await handleAs(recovering, credential), ['read', 'ci', '--json'])
    expect(refused).toMatchObject({ code: 1, stdout: '' })
    expect(JSON.parse(refused.stderr)).toMatchObject({
      reason: 'oidc_star_review_required', next: [{ argv: expect.arrayContaining(['grants', 'list']) }], data: { error: reviewError.body.error },
    })
    const listed = await vb(operator, ['grants', 'list'])
    expect(listed).toMatchObject({ code: 0, stderr: '', stdout: expect.stringMatching(/^g4 +.+needs oidc subject review$/m) })
    expect(await vb(operator, ['grants', 'acknowledge', 'g4'])).toEqual({ code: 0, stdout: 'acknowledged g4\n', stderr: '' })
    expect((await read(second)).body.can).toEqual({ ci: ['read', 'post'] })
    expect(await vb(operator, ['grants', 'acknowledge', 'g4', '--json'])).toEqual({ code: 0, stdout: '{"grant":"g4","outcome":"unchanged"}\n', stderr: '' })
    await Promise.all([second.backend.close(), recovering.backend.close()])
    const restarted = open()
    expect(await read(restarted)).toMatchObject({ status: 200, body: { can: { ci: ['read', 'post'] } } })
    expect((await (await callAs(restarted, personToken()))('GET', '/grants')).body.grants).toContainEqual(expect.objectContaining({ id: 'g4', by: 'vercel:user:u_reviewer' }))
    await restarted.backend.close()
    const replay = sqlite({ path })
    const events = await accessLog(replay).history().finally(() => replay.close())
    expect(events.filter((event) => event.index > updated!.index)).toMatchObject([
      { payload: { by: 'board:access', grants: [{ id: 4, version: updated!.index }] } },
      { payload: { id: 4, version: updated!.index, by: 'vercel:user:u_reviewer' } },
    ])
  })

  it('holds another star update for review and only admits the exact subject after a rewrite', async () => {
    const team = testBoard()
    await accessLog(team.store).append(stored(old))
    const person = await callAs(team, personToken())
    const oldPrefix = await callAs(team, oidcToken({ sub: 'tenant/release/preview' }))
    const newPrefix = await callAs(team, oidcToken({ sub: 'tenant/build/other' }))
    const exact = await callAs(team, oidcToken({ sub: 'tenant/build/main' }))
    const update = (remove: string, add: string) => person('PATCH', '/grants/g4', { remove: [subject(remove)], add: [subject(add)] })
    check(await oldPrefix('GET', '/me'))
    expect(await update(old, 'tenant/build/*')).toMatchObject({ status: 200, body: { grant: { needsOidcSubjectReview: true } } })
    check(await newPrefix('GET', '/me'))
    check(await exact('GET', '/me'))
    const rewritten = await update('tenant/build/*', 'tenant/build/main')
    expect(rewritten).toMatchObject({ status: 200 })
    expect(rewritten.body.grant).not.toHaveProperty('needsOidcSubjectReview')
    expect((await exact('GET', '/me')).status).toBe(200)
    for (const outside of [oldPrefix, newPrefix])
      expect(await outside('GET', '/me')).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } })
  })

  it('does not mark a new prefix created during review and restores access only after the last review clears', async () => {
    const team = testBoard()
    // Even a trailing star upstream won't parse as a prefix needs review.
    await accessLog(team.store).append(stored(old), stored('tenant/legacy*'))
    const person = await callAs(team, personToken())
    const fresh = await callAs(team, oidcToken({ sub: 'tenant/new/branch' }))
    const made = await person('POST', '/grants', { principals: [subject('tenant/new/*')], can: { ci: ['read'] } })
    expect(made.status).toBe(200)
    expect(made.body.grant).not.toHaveProperty('needsOidcSubjectReview')
    check(await fresh('GET', '/me'))
    expect(await person('POST', '/grants/g4/revoke')).toEqual({ status: 200, body: { revoked: true } })
    check(await fresh('GET', '/me'))
    expect(await person('POST', '/grants/g5/revoke')).toEqual({ status: 200, body: { revoked: true } })
    expect(await fresh('GET', '/me')).toMatchObject({ status: 200, body: { can: { ci: ['read'] } } })
  })

  it('keeps a clean board unchanged except for one empty baseline and does not re-baseline a new prefix', async () => {
    const first = testBoard()
    const log = accessLog(first.store)
    expect(await log.history()).toEqual([])
    const admin = await callAs(first, personToken())
    const before = await admin('GET', '/grants')
    expect(before.status).toBe(200)
    expect(before.body.grants.map((grant: { id: string }) => grant.id)).toEqual(['g1', 'g2', 'g3'])
    const initialized = await log.history()
    expect(initialized).toMatchObject([{ payload: { grants: [], by: 'board:access' } }])
    const restarted = testBoard({ store: first.store })
    for (const team of [first, restarted]) {
      expect(await (await callAs(team, personToken()))('GET', '/grants')).toEqual(before)
      expect((await (await callAs(team, deploymentToken()))('GET', '/me')).status).toBe(200)
    }
    expect(await log.history()).toEqual(initialized)
    expect((await admin('POST', '/grants', { principals: [subject('tenant/new/*')], can: { ci: ['read'] } })).status).toBe(200)
    const prefixed = await callAs(testBoard({ store: first.store }), oidcToken({ sub: 'tenant/new/main' }))
    expect(await prefixed('GET', '/me')).toMatchObject({ status: 200, body: { can: { ci: ['read'] } } })
  })

  it('takes no review provenance from bodies or approval from a caller without manage', async () => {
    const team = testBoard()
    await accessLog(team.store).append(stored(old))
    const person = await callAs(team, personToken('u_reviewer'))
    const narrowed = await callAs(team, personToken('u_reviewer'), { 'x-board-can': 'ci=read' })
    const workflow = await callAs(team, oidcToken({ sub: old }))
    const forged = { by: 'vercel:user:u_other', needsOidcSubjectReview: false, oidcStarPending: 0, version: 1 }
    const invalid = { status: 400, body: { error: { code: 'invalid_request' } } }
    expect(await person('PATCH', '/grants/g4', { can: { ci: ['read'] }, ...forged })).toMatchObject(invalid)
    expect(await person('POST', '/grants/g4/acknowledge', forged)).toMatchObject(invalid)
    expect(await person('POST', '/grants', { principals: [subject('tenant/new/*')], can: { ci: ['read'] }, ...forged, needsOidcSubjectReview: true })).toMatchObject(invalid)
    expect(await narrowed('POST', '/grants/g4/acknowledge')).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } })
    check(await workflow('POST', '/grants/g4/acknowledge'))
    expect((await person('GET', '/grants')).body.grants).toContainEqual(expect.objectContaining({ id: 'g4', by: 'vercel:user:u_previous', needsOidcSubjectReview: true }))
    check(await workflow('GET', '/me'))
  })
})
