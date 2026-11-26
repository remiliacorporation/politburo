import { spawn } from 'node:child_process'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createBoardClient, type BoardClient } from '../src/client/client.ts'
import { startInspector, type Inspector } from '../src/inspect/server.ts'
import { CLI, env, useBoard, vb } from './cli-harness.ts'
import { serve } from './http.ts'
import { personToken, testBoard } from './harness.ts'

useBoard()

let server: Awaited<ReturnType<typeof serve>>
let client: BoardClient
let inspector: Inspector
let token: string
let dir: string
const secret = Uint8Array.from([9, 9, 9, 9, 80, 78, 71])
const cow = Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4])

beforeAll(async () => {
  server = await serve(testBoard({ url: undefined }).fetch)
  const url = `${server.origin}/api/board`
  client = createBoardClient({ url, token: await personToken('u_julian', url), profile: null })
  dir = path.join(tmpdir(), `board-textures-${process.pid}`)
  const outside = path.join(tmpdir(), `board-textures-outside-${process.pid}.png`)
  await mkdir(path.join(dir, 'entity/cow'), { recursive: true })
  await writeFile(path.join(dir, 'entity/cow/cow.png'), cow)
  await writeFile(outside, secret)
  await symlink(outside, path.join(dir, 'entity/cow/escape.png'))
  inspector = await startInspector({ client, port: 0, textures: dir })
  const page = await (await fetch(`${inspector.url}/`)).text()
  token = /<meta name="inspect-token" content="([^"]+)">/.exec(page)![1]!
  expect(page).toContain('<meta name="inspect-textures" content="1">')
})

afterAll(async () => {
  await inspector.close()
  server.close()
})

it('serves a texture inside the directory and refuses one outside it', async () => {
  const headers = { 'x-inspect-token': token }
  const inside = await fetch(`${inspector.url}/textures/entity/cow/cow.png`, { headers })
  expect(inside.status).toBe(200)
  expect(inside.headers.get('content-type')).toBe('image/png')
  expect(new Uint8Array(await inside.arrayBuffer())).toEqual(cow)

  const missing = await fetch(`${inspector.url}/textures/entity/cow/missing.png`, { headers })
  expect(missing.status).toBe(404)

  const linked = await fetch(`${inspector.url}/textures/entity/cow/escape.png`, { headers })
  expect(linked.status).toBe(400)
  expect(new Uint8Array(await linked.arrayBuffer())).not.toEqual(secret)

  expect((await fetch(`${inspector.url}/textures/entity/cow/cow.png`)).status).toBe(403)
  expect(await raw('/textures/../secret.png')).toBe(400)
  expect(await raw('/textures/%2e%2e/secret.png')).toBe(400)
  expect(await raw('/textures/entity/cow/cow.png', { host: 'evil.example', 'x-inspect-token': token })).toBe(421)
})

it('prints the textures directory and serves the page from it', async () => {
  const child = spawn(process.execPath, [CLI, 'inspect', '--port', '0', '--no-open', '--textures', dir], { env })
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve))
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const address = await new Promise<string>((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const found = /at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)
      if (found) resolve(found[1]!)
    })
    child.on('exit', () => reject(new Error(`inspect exited early\n${stdout}\n${stderr}`)))
  })
  expect(stdout).toContain(`textures  ${dir}`)
  const page = await (await fetch(address)).text()
  expect(page).toContain('<meta name="inspect-textures" content="1">')
  child.kill('SIGINT')
  expect(await exited).toBe(0)
})

it('refuses inspect when the textures path is not a directory', async () => {
  const refused = await vb(['inspect', '--no-open', '--textures', path.join(dir, 'nope')])
  expect(refused.code).toBe(2)
  expect(refused.stderr).toContain('No textures directory')
  expect(refused.stdout).toBe('')
})

function raw(urlPath: string, headers: Record<string, string> = { 'x-inspect-token': token }): Promise<number> {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(inspector.url)
    const req = request({ hostname, port, path: urlPath, headers }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}
