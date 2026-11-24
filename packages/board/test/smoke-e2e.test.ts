import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { AttentionDraft, AttentionView, GrantView, Me, MessageView, SendOperationalMessageInput } from '../src/api/routes.ts'
import { mount } from './harness.ts'
import { serve } from './http.ts'
import { createLeakCheck, watchServe, type Output } from './smoke-output.ts'
import { personToken, testAuth } from './tokens.ts'

const CLI = join(import.meta.dirname, '../src/cli/bin.ts')
const INBOX_SENDER = join(import.meta.dirname, 'smoke-send-inbox.ts')
const CLI_TIMEOUT = 180_000
const CALL_TIMEOUT = 12_000
const COMMIT = 'a'.repeat(40)
const OWNER = 'vercel:user:u_owner'
const UUID = /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/
const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/
const leakCheck = createLeakCheck()

let dir: string
let url: string
let adminEnv: ReturnType<typeof homeEnv>
let memberEnv: ReturnType<typeof homeEnv>
let server: ReturnType<typeof watchServe> | undefined

function homeEnv(home: string) {
  const { PATH, NODE_ENV, NODE_NO_WARNINGS } = process.env
  return {
    PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    ...(NODE_ENV !== undefined ? { NODE_ENV } : {}),
    ...(NODE_NO_WARNINGS !== undefined ? { NODE_NO_WARNINGS } : {}),
    NO_PROXY: '127.0.0.1,localhost',
  }
}

function capture({ stdout, stderr }: Output, source: string) {
  leakCheck.capture(`${source} stdout`, stdout)
  leakCheck.capture(`${source} stderr`, stderr)
}

function expectNoCredential() {
  const leak = leakCheck.findLeak()
  // Only the labels and lengths, never the text or credential, reach the assertion.
  expect(leak === undefined, leak).toBe(true)
}

function trackToken(token: unknown, source: string) {
  const secret = typeof token === 'string' ? token : ''
  expect(leakCheck.track(secret, source), `${source} has no usable credential (length ${secret.length})`).toBe(true)
}

async function trackSavedTokens(config: string, kind: 'claims' | 'joined' | 'local', source: string) {
  // Only the CLI's hashed credential files inside homes created by this test.
  const folder = join(config, 'board', kind)
  const files = (await readdir(folder)).filter((name) => /^[a-f0-9]+\.json$/.test(name))
  expect(files.length, `${source} count`).toBeGreaterThan(0)
  for (const file of files) {
    const saved = parse<{ token?: unknown } | null>(await readFile(join(folder, file), 'utf8'), source)
    trackToken(saved?.token, source)
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'board-smoke-'))
  // An empty .git is not a checkout: vb must find the board by URL.
  await mkdir(join(dir, '.git'))
  adminEnv = homeEnv(await mkdtemp(join(dir, 'admin-')))
  memberEnv = homeEnv(await mkdtemp(join(dir, 'member-')))
  const child = spawn(process.execPath, [CLI, 'serve', '--agent-ops', '--no-inspect', '--port', '0', '--dir', join(dir, 'data')], {
    cwd: dir, env: adminEnv, stdio: ['ignore', 'pipe', 'pipe'],
  })
  server = watchServe(child)
  url = await server.waitForUrl(CALL_TIMEOUT)
  await trackSavedTokens(adminEnv.XDG_CONFIG_HOME, 'local', 'local login file')
}, 20_000)

afterAll(async () => {
  try {
    if (server) {
      const { child, closed, output } = server
      child.kill('SIGTERM')
      const teardown = new AbortController()
      try {
        await Promise.race([
          closed,
          delay(5_000, undefined, { signal: teardown.signal }).then(async () => {
            child.kill('SIGKILL')
            await delay(5_000, undefined, { signal: teardown.signal })
            throw new Error('vb serve did not close after SIGKILL')
          }),
        ])
      } finally {
        teardown.abort()
        capture(output, 'vb serve')
      }
    }
    expectNoCredential()
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true })
  }
}, 20_000)

type CommandFiles = { stdinFile?: string; trackSecrets?: () => Promise<void> }

async function runNode(script: string, args: string[], env: NodeJS.ProcessEnv, command: string, { stdinFile, trackSecrets }: CommandFiles = {}) {
  // Feed the invite file from stdin, never through argv.
  const input = stdinFile === undefined ? undefined : await open(stdinFile, 'r')
  try {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: dir, env, stdio: [input?.fd ?? 'ignore', 'pipe', 'pipe'], timeout: CALL_TIMEOUT, killSignal: 'SIGKILL',
    })
    const output = { stdout: '', stderr: '' }
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { output.stdout += chunk })
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { output.stderr += chunk })
    const [code, signal] = await once(child, 'close').catch(() => { throw new Error(`${command} could not start`) }) as [number | null, NodeJS.Signals | null]
    capture(output, script === CLI ? 'vb' : 'SDK inbox send')
    // Learn newly saved credentials before any assertion can echo the command's output.
    if (code === 0) await trackSecrets?.()
    expectNoCredential()
    if (code === null) throw new Error(`${command} stopped by ${signal} (timeout ${CALL_TIMEOUT}ms)`)
    return { code, ...output }
  } finally {
    await input?.close()
  }
}

type Refusal = { reason: string; message: string; data?: { error?: { status: number } } }

function parse<T>(body: string, command: string): T {
  try {
    return JSON.parse(body) as T
  } catch {
    throw new Error(`${command} did not produce JSON`)
  }
}

function cli(env: NodeJS.ProcessEnv, prefix: string[] = []) {
  const command = (args: string[]) => `vb ${[...prefix, ...args].join(' ')}`
  const run = (args: string[], files?: CommandFiles) => runNode(CLI, [...prefix, ...args], env, command(args), files)
  const text = async (args: string[], files?: CommandFiles) => {
    const output = await run(args, files)
    expect(output.code === 0 && output.stderr === '',
      `${command(args)} (exit code ${output.code}; stdout length ${output.stdout.length}; stderr length ${output.stderr.length})`,
    ).toBe(true)
    return output.stdout.trimEnd()
  }
  return {
    text,
    async json<T = unknown>(args: string[]): Promise<T> {
      return parse<T>(await text([...args, '--json']), command(args))
    },
    async refuses(args: string[], reason: string, stdinFile?: string) {
      const { code, stdout, stderr } = await run([...args, '--json'], { stdinFile })
      expect({ code, stdout }, command(args)).toEqual({ code: 1, stdout: '' })
      const error = parse<Refusal>(stderr, command(args))
      expect(error.reason, command(args)).toBe(reason)
      return error
    },
  }
}

async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw new Error(label, { cause: error })
  }
}

async function writeDraft(path: string, { id, revision }: Pick<MessageView, 'id' | 'revision'>) {
  const draft: AttentionDraft = {
    kind: 'awaiting_approval', question: 'Publish the release notes?', context: 'The review is complete.',
    options: [
      { id: 'publish', label: 'Publish', consequence: 'Resume the release', next: 'resume' },
      { id: 'stop', label: 'Stop', consequence: 'Do not publish', next: 'fail' },
    ],
    evidence: [{ message: id, revision }], revision, commit: COMMIT, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  }
  await writeFile(path, JSON.stringify(draft))
  leakCheck.capture('draft file', await readFile(path, 'utf8'))
  expectNoCredential()
  return draft
}

// vb has no inbox send. Run the SDK with the selected home so it can use vb's saved login.
function sendInbox(env: NodeJS.ProcessEnv, input: SendOperationalMessageInput) {
  return runNode(INBOX_SENDER, [url, JSON.stringify(input)], env, 'SDK inbox send')
}

it('runs a work queue from invitation to handoff, pause, and follow-up', async () => {
  const admin = cli({ ...adminEnv, BOARD_URL: url })
  const workerEnv = homeEnv(await mkdtemp(join(dir, 'worker-')))
  // The worker uses the local admin's login under a profile, but keeps its own config snapshot.
  await cp(adminEnv.XDG_CONFIG_HOME, workerEnv.XDG_CONFIG_HOME, { recursive: true })
  const worker = cli({ ...workerEnv, BOARD_URL: url }, ['--as', 'worker'])
  const claimFiles = { trackSecrets: () => trackSavedTokens(workerEnv.XDG_CONFIG_HOME, 'claims', 'claim file') }
  const member = cli(memberEnv, ['--url', url])
  const draftPath = join(dir, 'draft.json')

  const adminPrincipal = await step('identify the running board and its local admin', async () => {
    expect(await admin.text(['status'])).toBe('board  running')
    const me = await admin.json<Me>(['whoami'])
    expect(me).toMatchObject({
      principal: expect.stringMatching(/^local:user:[a-z0-9._-]+$/),
      actor: me.principal, handle: me.principal?.slice('local:user:'.length),
      board: url, source: 'vb serve', can: { '*': expect.arrayContaining(['manage']) },
    })
    expect((await admin.text(['whoami'])).split('\n')).toEqual(expect.arrayContaining([
      `${me.handle} (${me.principal})`, `board   ${url}`, 'source  vb serve',
    ]))
    return me.principal
  })

  const memberPrincipal = await step('invite Sam, join from stdin in a second config, and refuse reuse', async () => {
    const file = join(dir, 'sam.invite')
    const scope = 'work/=read,post'
    const [created, written] = (await admin.text(['invite', 'create', 'sam', '--out', file, '--can', scope], {
      trackSecrets: async () => trackToken((await readFile(file, 'utf8')).replace(/\n$/, ''), 'invite file'),
    })).split('\n')
    const pending = new RegExp(`^created (${UUID.source})  sam  pending  ${ISO.source}  ${scope}$`)
    expect(created).toMatch(pending)
    expect(written).toBe(`file  ${file}`)
    const id = pending.exec(created!)![1]!
    const row = (state: string) => new RegExp(`^${id}  sam  ${state}  ${ISO.source}  ${scope}$`, 'm')
    expect(await admin.text(['invite', 'list'])).toMatch(row('pending'))

    const joiner = cli(memberEnv)
    const joinArgs = ['join', url, '-']
    const [joined, where] = (await joiner.text(joinArgs, {
      stdinFile: file,
      trackSecrets: () => trackSavedTokens(memberEnv.XDG_CONFIG_HOME, 'joined', 'join file'),
    })).split('\n')
    expect(joined).toMatch(new RegExp(`^joined joined:user:${UUID.source}$`))
    expect(where).toBe(`board  ${url}`)
    const principal = joined!.slice('joined '.length)
    expect((await member.text(['whoami'])).split('\n')).toEqual(expect.arrayContaining([
      `sam (${principal})`, `board   ${url}`, 'source  vb join', 'can     work/  read post',
    ]))
    expect(await admin.text(['invite', 'list'])).toMatch(row('redeemed'))
    await joiner.refuses(joinArgs, 'invalid_invite', file)
    return principal
  })

  await step('register the controller and worker and record the worker heartbeat', async () => {
    async function register(role: string, profile: string) {
      const lines = (await admin.text(['agents', 'register', 'work', '--role', role, '--harness', 'shell', '--as', profile])).split('\n')
      expect(lines[0]).toMatch(new RegExp(`^\\S+  ${role}$`))
      expect(lines).toEqual(expect.arrayContaining([
        '  channel     work', `  principal   ${adminPrincipal}`, `  profile     ${profile}`,
        '  harness     shell', '  generation  1', '  status      enabled', '  heartbeat   none',
      ]))
      return lines[0]!.split('  ')[0]!
    }
    const boss = await register('controller', 'boss')
    const runner = await register('implementation-worker', 'worker')
    expect(await worker.text(['agents', 'heartbeat', runner, '--generation', '1'])).toMatch(new RegExp(`^  heartbeat   ${ISO.source}$`, 'm'))
    expect(await admin.json(['agents', 'list', 'work'])).toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({ id: boss, role: 'controller' }),
        expect.objectContaining({ id: runner, role: 'implementation-worker', heartbeatAt: expect.stringMatching(ISO) }),
      ]),
    })
  })

  const lowText = 'Tidy the runbook'
  const urgentText = 'Check the release notes'
  const dependentText = 'Publish the release notes'
  const next = ['tasks', 'claim', 'work', '--ready', '--lease', '5m']
  const { low, urgent, dependent } = await step('queue tasks, check unclaimed health, and claim urgent work first', async () => {
    async function create(text: string, ...flags: string[]) {
      const id = await admin.text(['tasks', 'create', 'work', text, ...flags])
      expect(id).toMatch(/^\d+$/)
      return id
    }
    const low = await create(lowText, '--priority', 'low')
    const urgent = await create(urgentText, '--priority', 'urgent')
    const dependent = await create(dependentText, '--needs', urgent)
    const tasks = await admin.text(['tasks', 'work'])
    expect(tasks).toMatch(new RegExp(`^#${low} +ready +low +${lowText}$`, 'm'))
    expect(tasks).toMatch(new RegExp(`^#${urgent} +ready +urgent +${urgentText}$`, 'm'))
    expect(tasks).toMatch(new RegExp(`^#${dependent} +waiting +normal +${dependentText} +needs #${urgent}$`, 'm'))
    expect(await admin.json(['agents', 'health', urgent])).toEqual({ health: { state: 'not_confirmed' } })
    expect(await worker.text(next, claimFiles)).toBe(`#${urgent}  yours for 5m  ${urgentText}`)
    return { low, urgent, dependent }
  })

  await step('let the worker lower priority and the owner raise it without a claim', async () => {
    expect(await worker.text(['tasks', 'priority', urgent, 'high'])).toBe(`${urgent}  priority high`)
    const denied = await worker.refuses(['tasks', 'priority', urgent, 'urgent'], 'priority_raise_forbidden')
    expect(denied.message).toContain('A claim can lower priority, not raise it')
    const { message } = await admin.json<{ message: MessageView }>(['read', urgent])
    expect(message.task?.priority).toBe('high')
    expect(await admin.text(['tasks', 'priority', urgent, 'urgent'])).toBe(`${urgent}  priority urgent`)
  })

  await step('renew, hand off, and complete urgent work, then claim its newly ready dependent', async () => {
    expect(await worker.text(['tasks', 'renew', urgent], claimFiles)).toBe(`#${urgent}  yours for 15m  ${urgentText}`)
    const { message } = await admin.json<{ message: MessageView }>(['read', urgent])
    expect(Date.parse(message.task?.claim?.until ?? '') - Date.now()).toBeGreaterThan(6 * 60_000)
    const packetPath = 'docs/packet.md'
    const sha256 = 'b'.repeat(64)
    const result = 'Checked the release notes against the changelog.'
    expect(await worker.text(['tasks', 'handoff', urgent, COMMIT, packetPath, sha256])).toMatch(new RegExp(`^handed off ${urgent}  ${UUID.source}$`))
    expect(await worker.text(['tasks', 'complete', urgent, result])).toBe(`completed ${urgent}`)
    expect(await admin.json(['read', urgent])).toMatchObject({ message: {
      id: urgent, task: { state: 'completed', result, handoff: { commit: COMMIT, packetPath, sha256 } },
    } })
    expect(await admin.json(['read', dependent])).toMatchObject({ message: { id: dependent, task: { state: 'ready' } } })
    expect(await worker.text(next, claimFiles)).toBe(`#${dependent}  yours for 5m  ${dependentText}`)
  })

  await step('document the task attention refusal on vb serve', async () => {
    const { message } = await admin.json<{ message: MessageView }>(['read', low])
    await writeDraft(draftPath, message)
    // vb serve does not configure attentionResponders.
    for (const args of [['tasks', 'ask', low, '--file', draftPath], ['tasks', 'attention', low]]) {
      expect(await admin.refuses(args, 'no_task_attention')).toMatchObject({ data: { error: { status: 501 } } })
    }
  })

  await step('pause work and fence the old claim even after the same worker reclaims it', async () => {
    const config = workerEnv.XDG_CONFIG_HOME
    const beforePause = join(dir, 'before-pause')
    const afterReclaim = join(dir, 'after-reclaim')
    async function restore(snapshot: string) {
      await rm(config, { recursive: true, force: true })
      await cp(snapshot, config, { recursive: true })
    }
    await cp(config, beforePause, { recursive: true })
    expect(await admin.text(['pause', '--reason', 'smoke'])).toBe('board  paused')
    expect(await admin.json(['status'])).toEqual({ paused: true, pauseEpoch: 1 })
    await worker.refuses(['tasks', 'claim', low], 'board_paused')
    expect(await admin.text(['resume', '--reason', 'ok'])).toBe('board  running')
    expect(await worker.text(['tasks', 'claim', low, '--lease', '5m'], claimFiles)).toBe(`#${low}  yours for 5m  ${lowText}`)
    await worker.refuses(['tasks', 'complete', dependent, 'x'], 'claim_lost')

    expect(await worker.text(['tasks', 'claim', dependent, '--lease', '5m'], claimFiles)).toBe(`#${dependent}  yours for 5m  ${dependentText}`)
    await cp(config, afterReclaim, { recursive: true })
    await restore(beforePause)
    await worker.refuses(['tasks', 'complete', dependent, 'x'], 'claim_lost')
    await restore(afterReclaim)
    expect(await worker.text(['tasks', 'complete', dependent, 'published'])).toBe(`completed ${dependent}`)
    expect(await worker.text(['tasks', 'complete', low, 'done'])).toBe(`completed ${low}`)
  })

  await step('deliver private inbox mail and record seen, acted, and archived receipts', async () => {
    const outgoing = { to: { agent: memberPrincipal }, topic: 'Release', text: 'The release notes are published.' }
    await member.refuses(['inbox', 'read'], 'permission_denied')

    // The inbox requires board-wide read. Add it to Sam's invite grant, keeping post scoped to work/.
    const { grants } = await admin.json<{ grants: GrantView[] }>(['grants', 'list'])
    const grant = grants.find(({ principals }) => principals.some((p) => p.kind === 'invitee' && p.id === memberPrincipal))
    expect(grant, 'grant for the joined member').toBeDefined()
    await admin.text(['grants', 'update', grant!.id, '--can', '*=read;work/=read,post'])

    // A sender's credentials must not depend on which other request is in flight.
    const [sent, denied] = await Promise.all([
      sendInbox(adminEnv, outgoing),
      sendInbox(memberEnv, { to: { agent: adminPrincipal }, topic: 'Release', text: 'Thanks for the update.' }),
    ])
    expect(sent).toMatchObject({ code: 0, stderr: '' })
    const { id } = parse<{ id: string }>(sent.stdout, 'SDK inbox send')
    expect(denied).toMatchObject({ code: 1, stdout: '' })
    expect(parse(denied.stderr, 'unauthorized SDK inbox send')).toMatchObject({ status: 403, code: 'forbidden' })

    expect(await admin.json(['inbox', 'read'])).toEqual({ messages: [] })
    await admin.refuses(['inbox', 'ack', id, 'seen'], 'operational_message_not_found')
    await admin.refuses(['inbox', 'archive', id], 'operational_message_not_found')
    expect(await member.json(['inbox', 'read'])).toMatchObject({ messages: [
      { id, ...outgoing, by: { principal: adminPrincipal }, seenAt: null, actedAt: null, archivedAt: null },
    ] })
    const seen = { id, seenAt: expect.stringMatching(ISO), actedAt: null, archivedAt: null }
    const acted = { ...seen, actedAt: expect.stringMatching(ISO) }
    expect(await member.json(['inbox', 'ack', id, 'seen'])).toMatchObject({ message: seen })
    expect(await member.json(['inbox', 'ack', id, 'acted'])).toMatchObject({ message: acted })
    expect(await member.json(['inbox', 'archive', id])).toMatchObject({ message: { ...acted, archivedAt: expect.stringMatching(ISO) } })
    expect(await member.json(['inbox', 'read'])).toEqual({ messages: [] })
  })

  await step('ask, show, and answer attention on a second, in-process board with responders configured', async () => {
    // Only this board enables attentionResponders; the CLI still reaches it over HTTP in subprocesses.
    let team: ReturnType<typeof mount>
    const attentionServer = await serve((request) => team.fetch(request))
    try {
      const at = `${attentionServer.origin}/api/board`
      team = mount({ url: at, auth: testAuth, attentionResponders: { work: [OWNER] } })
      const home = await mkdtemp(join(dir, 'attention-'))
      const token = await personToken('u_owner', at)
      trackToken(token, 'attention test bearer')
      const owner = cli({ ...homeEnv(home), BOARD_URL: at, BOARD_TOKEN: token })
      const { task } = await owner.json<{ task: MessageView }>(['tasks', 'create', 'work', 'Review the release notes'])
      const draft = await writeDraft(draftPath, task)
      const opened = await owner.json<{ attention: AttentionView }>(['tasks', 'ask', task.id, '--file', draftPath])
      expect(opened).toMatchObject({ task: { id: task.id, task: { state: 'blocked' } }, attention: { status: 'pending', question: draft.question } })
      const request = opened.attention.id
      const option = draft.options[0]!.id
      expect((await owner.text(['tasks', 'attention', task.id])).split('\n')).toEqual(expect.arrayContaining([
        `request   ${request}  pending`, `question  ${draft.question}`, `  ${option}  resume`,
      ]))
      expect(await owner.json(['tasks', 'answer', task.id, request, option, '--commit', COMMIT])).toMatchObject({
        attention: { id: request, status: 'answered', receipt: { option, routedTo: 'ready' } },
      })
      expect(await owner.json(['read', task.id])).toMatchObject({ message: { id: task.id, task: { state: 'ready' } } })
    } finally {
      await attentionServer.close()
    }
  })
}, CLI_TIMEOUT)
