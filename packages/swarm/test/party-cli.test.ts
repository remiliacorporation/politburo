import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Registry } from '../src/party/model.ts'

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const exec = promisify(execFile)

const party = { id: 'red', name: 'Red', colour: '#b3261e', members: [] }
const registry = { version: 1, jockeys: [], parties: [party] }

function partyCli(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-party-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'registry.json')
  const call = (args: string[], registryEnv?: string) => {
    const result = spawnSync(process.execPath, [cli, 'party', ...args], {
      cwd: dir, env: { ...process.env, SWARM_REGISTRY: registryEnv }, encoding: 'utf8',
    })
    if (result.error) throw result.error
    return result
  }
  const run = (...args: string[]) => call([...args, '--registry', file])
  return { dir, file, call, run }
}

test('party CLI persists add and member changes and emits one JSON document per read', (t) => {
  const { file, run } = partyCli(t)
  const email = 'a@x.com'
  const steps = [
    { args: ['add', 'red', '--name', 'Red', '--colour', '#b3261e'], members: [] },
    { args: ['member', 'add', 'red', email], members: [{ email, role: 'member' }] },
    { args: ['member', 'set', 'red', email, '--role', 'reader'], members: [{ email, role: 'reader' }] },
    { args: ['member', 'remove', 'red', email], members: [] },
  ]
  for (const { args, members } of steps) {
    const result = run(...args)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      ...registry, parties: [{ ...party, members }],
    }, args.join(' '))
  }

  const saved = readFileSync(file, 'utf8')
  for (const [args, expected] of [[['list'], registry], [['show', 'red'], { party }]] as const) {
    const result = run(...args, '--json')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), expected)
    assert.equal(readFileSync(file, 'utf8'), saved)
  }
})

test('party CLI distinguishes command failures from misuse without changing the registry', (t) => {
  const { file, run } = partyCli(t)
  const before = JSON.stringify(registry)
  writeFileSync(file, before)

  for (const [args, status, error] of [
    [['member', 'remove', 'missing', 'a@x.com'], 1, /^error: .*unknown party missing/],
    [['member', 'add', 'red', 'A@x.com'], 1, /^error: /],
    [['member', 'remove', 'red'], 2, /^error: /],
  ] as const) {
    const result = run(...args)
    assert.equal(result.status, status, args.join(' '))
    assert.match(result.stderr, error)
    assert.equal(readFileSync(file, 'utf8'), before)
  }
})

test('party CLI refuses an implicit registry in the working directory but accepts SWARM_REGISTRY', (t) => {
  const { dir, file, call } = partyCli(t)
  const args = ['add', 'red', '--name', 'Red', '--colour', '#b3261e']
  const missing = call(args)
  assert.equal(missing.status, 2, missing.stderr)
  assert.equal(missing.stderr.split('\n')[0], 'error: no registry file: pass --registry FILE or set SWARM_REGISTRY')
  assert.ok(!existsSync(join(dir, 'parties.json')))

  const configured = call(args, file)
  assert.equal(configured.status, 0, configured.stderr)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), registry)
})

test('concurrent party CLI member adds do not overwrite one another', async (t) => {
  const { dir, file } = partyCli(t)
  // An existing roster widens the read-to-write window so the race is observable.
  const members = Array.from({ length: 4096 }, (_, i) => ({ email: `existing${i}@x.com`, role: 'member' }))
  writeFileSync(file, JSON.stringify({ ...registry, parties: [{ ...party, members }] }))
  const emails = Array.from({ length: 8 }, (_, i) => `new${i}@x.com`)
  await Promise.all(emails.map((email) => exec(process.execPath,
    [cli, 'party', 'member', 'add', 'red', email, '--registry', file], { cwd: dir })))

  const saved: Registry = JSON.parse(readFileSync(file, 'utf8'))
  const savedEmails = new Set(saved.parties[0]!.members.map(({ email }) => email))
  assert.deepEqual(emails.filter((email) => !savedEmails.has(email)), [], 'missing concurrent additions')
})
