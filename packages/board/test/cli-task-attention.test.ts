import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AttentionDraft, AttentionView } from '../src/api/routes.ts'
import { http } from '../src/backend-http/index.ts'
import { board, mount } from './harness.ts'
import { serve } from './http.ts'
import { bearer, personToken, testAuth } from './tokens.ts'

const COMMIT = 'a'.repeat(40)
const OWNER = 'vercel:user:u_owner'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'board-cli-ask-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const team = mount({ auth: testAuth, attentionResponders: { work: [OWNER] } })
  let held: ((status: number) => Promise<void>) | undefined
  const server = await serve(async (request) => {
    const reply = await team.fetch(request)
    if (held && request.method === 'POST' && new URL(request.url).pathname.endsWith('/attention')) {
      const atGate = held
      held = undefined
      await atGate(reply.status)
    }
    return reply
  })
  cleanup.push(server.close)
  const url = `${server.origin}/api/board`
  const token = await personToken('u_owner', url)
  const client = board({ backend: http(url, { fetch: bearer(fetch, token) }) })
  const { task } = await client.tasks.create('work', 'Review the release')
  const { id, revision } = task
  const draft: AttentionDraft = {
    kind: 'awaiting_approval', question: 'Release this build?', context: '',
    options: [
      { id: 'Go_now-2', label: 'Go', consequence: 'Release the build', next: 'resume' },
      { id: '3' + 'a'.repeat(63), label: 'Stop', consequence: 'Do not release', next: 'fail' },
    ],
    evidence: [{ message: id, revision }], expiresAt: new Date(Date.now() + 60_000).toISOString(), revision, commit: COMMIT,
  }
  const path = join(home, 'request.json')
  const writeDraft = (body: AttentionDraft & { replaces?: string } = draft) => writeFile(path, JSON.stringify(body))
  await writeDraft()
  const cli = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [join(import.meta.dirname, '../src/cli/bin.ts'), 'tasks', ...args], {
      cwd: home,
      env: { HOME: home, XDG_CONFIG_HOME: home, BOARD_URL: url, BOARD_TOKEN: token },
      timeout: 8_000,
    }, (error, stdout, stderr) => {
      if (!error) resolve({ code: 0, stdout, stderr })
      else if (typeof error.code === 'number') resolve({ code: error.code, stdout, stderr })
      else reject(error)
    })
  })
  return {
    id, draft, writeDraft, client, cli, ask: () => cli('ask', id, '--file', path, '--json'),
    holdAskReply() {
      const gate = Promise.withResolvers<void>()
      const response = Promise.withResolvers<number>()
      held = async (status) => {
        response.resolve(status)
        await gate.promise
      }
      return { status: response.promise, release: () => gate.resolve() }
    },
  }
}

it('rejects non-ASCII, shell-unsafe, and out-of-bounds option IDs over HTTP', async () => {
  const { client, id, draft } = await setup()
  for (const badId of ['go\nnow', 'go␊now', 'go\n', 'go now', '-go', '_go', 'go.now', 'a'.repeat(65), '']) {
    const request = { ...draft, options: [{ ...draft.options[0]!, id: badId }, draft.options[1]!] }
    await expect(client.tasks.ask(id, request), JSON.stringify(badId)).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
  }
  expect(await client.tasks.attention(id)).toEqual({ attention: null })
})

it('rejects ambiguous drafts in the CLI and accepts a choice copied from plain attention output', async () => {
  const { cli, id, draft, writeDraft, ask } = await setup()
  await writeDraft({ ...draft, options: [{ ...draft.options[0]!, id: 'go\nnow' }, { ...draft.options[1]!, id: 'go␊now' }] })
  expect(await ask()).toMatchObject({ code: 2, stdout: '' })

  await writeDraft()
  const opened = await ask()
  expect(opened).toMatchObject({ code: 0, stderr: '' })
  const { attention } = JSON.parse(opened.stdout) as { attention: AttentionView }
  const refused = await cli('complete', id, '--json')
  expect(refused).toMatchObject({ code: 1, stdout: '' })
  expect(JSON.parse(refused.stderr)).toMatchObject({
    reason: 'claim_not_held',
    message: expect.stringContaining('It needs a structured answer'),
    next: [{ argv: ['vb', 'tasks', 'attention', id] }],
  })
  const shown = await cli('attention', id)
  expect(shown).toMatchObject({ code: 0, stderr: '' })
  const lines = shown.stdout.split('\n')
  expect(lines).toContain(`  ${draft.options[1]!.id}  fail`)
  const displayedResume = lines.find((line) => /^  \S+  resume$/.test(line))?.trim().split(/\s+/)[0]
  expect(displayedResume).toBe(draft.options[0]!.id)
  const answered = await cli('answer', id, attention.id, displayedResume!, '--commit', COMMIT, '--json')
  expect(answered).toMatchObject({ code: 0, stderr: '' })
  expect(JSON.parse(answered.stdout)).toMatchObject({ attention: { receipt: { option: displayedResume, routedTo: 'ready' } } })
})

it.each(['with proof', 'without proof', 'with rejected proof'] as const)('a delayed ask %s leaves the next CLI claim usable', async (mode) => {
  const { client, cli, id, draft, writeDraft, ask, holdAskReply } = await setup()
  if (mode !== 'without proof') expect(await cli('claim', id)).toMatchObject({ code: 0, stderr: '' })
  if (mode === 'with rejected proof') {
    vi.useFakeTimers({ toFake: ['Date'] })
    // Leave the CLI's proof in place, but let the board's default 15-minute lease run out.
    vi.setSystemTime(Date.now() + 16 * 60_000)
    await writeDraft({ ...draft, expiresAt: new Date(Date.now() + 60_000).toISOString() })
  }
  const reply = holdAskReply()
  const asking = ask()
  try {
    const status = await Promise.race([reply.status, asking.then(({ code, stderr }) => {
      throw new Error(`ask exited before it reached the server gate (${code}): ${stderr}`)
    })])
    expect(status).toBe(mode === 'with rejected proof' ? 409 : 201)
    if (mode !== 'with rejected proof') {
      const { attention } = await client.tasks.attention(id)
      expect(attention?.status).toBe('pending')
      await client.tasks.answer(id, attention!.id, { option: draft.options[0]!.id, commit: COMMIT })
    }
    expect(await cli('claim', id)).toMatchObject({ code: 0, stderr: '' })
  } finally {
    reply.release()
    await asking
  }
  const result = await asking
  if (mode === 'with rejected proof') {
    expect(result).toMatchObject({ code: 1, stdout: '' })
    expect(JSON.parse(result.stderr)).toMatchObject({ reason: 'task_claimed' })
  } else expect(result).toMatchObject({ code: 0, stderr: '' })
  expect(await cli('complete', id)).toEqual({ code: 0, stdout: `completed ${id}\n`, stderr: '' })
})

it('can ask again and replace the request after a claimed task is resumed without reclaiming it', async () => {
  const { client, cli, id, draft, writeDraft, ask } = await setup()
  expect(await cli('claim', id)).toMatchObject({ code: 0, stderr: '' })
  const first = await ask()
  expect(first).toMatchObject({ code: 0, stderr: '' })
  const { attention: original } = JSON.parse(first.stdout) as { attention: AttentionView }
  await client.tasks.answer(id, original.id, { option: draft.options[0]!.id, commit: COMMIT })
  const second = await ask()
  expect(second).toMatchObject({ code: 0, stderr: '' })
  const { attention } = JSON.parse(second.stdout) as { attention: AttentionView }
  expect(attention).toMatchObject({ status: 'pending' })
  expect(attention.id).not.toBe(original.id)
  await writeDraft({ ...draft, question: 'Release after rechecking?', replaces: attention.id })
  const replaced = await ask()
  expect(replaced).toMatchObject({ code: 0, stderr: '' })
  expect(JSON.parse(replaced.stdout)).toMatchObject({ attention: { status: 'pending', question: 'Release after rechecking?' } })
})
