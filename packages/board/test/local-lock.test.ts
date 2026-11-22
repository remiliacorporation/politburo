import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { expect, it } from 'vitest'
import { local } from '../src/backend-local/index.ts'
import { board } from '../src/server/index.ts'

// Run the source entry points with Node's type stripping, as the CLI tests do.
const owner = `
  import { createInterface } from 'node:readline'
  import { local } from ${JSON.stringify(new URL('../src/backend-local/index.ts', import.meta.url).href)}
  import { board } from ${JSON.stringify(new URL('../src/server/index.ts', import.meta.url).href)}
  const dir = process.argv[1]
  const first = local({ dir })
  const second = local({ dir })
  const team = board({ backend: first })
  const named = board({ backend: second, name: 'named' })
  const commands = createInterface({ input: process.stdin })
  for await (const command of commands) {
    if (command === 'close-first') {
      await first.close()
      console.log('closed first')
    } else if (command === 'close-last') {
      await second.close()
      console.log('closed last')
    } else if (command === 'write-named') {
      console.log((await named.post('dev', command)).text)
    } else {
      console.log((await team.post('dev', command)).text)
    }
  }
`

function startOwner(dir: string) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', owner, dir], { env: {} })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (data) => (stderr += data))
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
  return {
    async send(command: string) {
      child.stdin.write(`${command}\n`)
      const line = await lines.next()
      if (line.done) throw new Error(`owner exited before answering ${command}: ${stderr}`)
      return line.value
    },
    kill() {
      child.kill('SIGKILL')
      return exited
    },
  }
}

it('locks the local directory until its last store closes or its owner is killed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-lock-'))
  const path = join(dir, '.board')
  let owner = startOwner(path)
  const backend = local({ dir: path })
  const recovered = local({ dir: path })
  // A different board name still shares the directory lock.
  const team = board({ backend, name: 'contender' })
  const locked = {
    status: 409, code: 'board_dir_locked', origin: 'handle',
    message: "another process owns this board's directory",
    hint: expect.stringContaining('--url'),
  }
  try {
    expect(await owner.send('first write')).toBe('first write')
    await expect(team.post('dev', 'blocked')).rejects.toMatchObject(locked)
    expect(await owner.send('still writing')).toBe('still writing')
    expect(await owner.send('write-named')).toBe('write-named')
    expect(await owner.send('close-first')).toBe('closed first')
    await expect(team.post('dev', 'still blocked')).rejects.toMatchObject(locked)
    expect(await owner.send('close-last')).toBe('closed last')
    expect((await team.post('dev', 'after close')).text).toBe('after close')
    await backend.close()

    await owner.kill()
    owner = startOwner(path)
    expect(await owner.send('before SIGKILL')).toBe('before SIGKILL')
    expect(await owner.kill()).toEqual({ code: null, signal: 'SIGKILL' })
    const reopened = board({ backend: recovered })
    const messages = await reopened.channel('dev').messages()
    expect(messages.messages.map((message) => message.text)).toContain('before SIGKILL')
    expect((await reopened.post('dev', 'after SIGKILL')).text).toBe('after SIGKILL')
  } finally {
    await owner.kill()
    await backend.close()
    await recovered.close()
    await rm(dir, { recursive: true, force: true })
  }
}, 20_000)

it('returns a path-free directory conflict to the handle and unauthenticated discovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-lock-'))
  const owner = startOwner(dir)
  const backend = local({ dir })
  const team = board({ backend })
  const error = {
    code: 'board_dir_locked',
    message: "another process owns this board's directory",
    hint: 'Use --url to reach the board in that process.',
  }
  try {
    expect(await owner.send('holding the directory')).toBe('holding the directory')
    const response = await team.fetch(new Request('http://localhost/'))
    expect(response.status).toBe(409)
    const body = await response.text()
    expect(body).not.toContain(dir)
    expect(JSON.parse(body)).toEqual({ error })
    await expect(team.channels()).rejects.toMatchObject({ ...error, status: 409, origin: 'handle' })
  } finally {
    await owner.kill()
    await backend.close()
    await rm(dir, { recursive: true, force: true })
  }
}, 20_000)
