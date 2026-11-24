import assert from 'node:assert/strict'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { RegistryError, validateRegistry, type Registry } from '../src/party/model.ts'
import { principalOf } from '../src/party/principal.ts'
import { channelsFor } from '../src/party/roles.ts'
import { loadRegistry, saveRegistry } from '../src/party/store.ts'

const member = { email: 'a@x.com', role: 'member' } as const
const party = { id: 'red', name: 'Red', colour: '#b3261e', members: [member] }
const registry: Registry = { version: 1, jockeys: ['j@x.com'], parties: [party] }

function mappedUser(email: string): string | undefined {
  try {
    return principalOf(email).userId
  } catch (error) {
    if (!(error instanceof RegistryError)) throw error
    return undefined
  }
}

test('principal IDs are board-safe and cannot alias different emails', () => {
  const { id, userId } = principalOf('a-b_0.z@b.x.com')
  assert.equal(userId, 'a-b_0.z.at.b.x.com')
  assert.equal(id, `cloudflare:person:${userId}`)
  const boardUserId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/
  assert.match(userId, boardUserId)
  for (const email of ['A@x.com', 'a@X.com', 'a+b@x.com', 'a/b@x.com']) {
    assert.throws(() => principalOf(email), RegistryError, email)
  }
  assert.throws(() => principalOf(`${'a'.repeat(192)}@x.com`), RegistryError)
  for (const [left, right] of [['a@b.at.x.com', 'a.at.b@x.com'], ['a.at@x.com', 'a@at.x.com']] as const) {
    const users = [mappedUser(left), mappedUser(right)].filter((user) => user !== undefined)
    for (const user of users) assert.match(user, boardUserId)
    assert.equal(new Set(users).size, users.length, `${left} and ${right} alias`)
  }
})

test('registry rejects stray fields, invalid party data, duplicates and unknown roles', () => {
  for (const [field, value] of [
    ['extra', { ...registry, extra: true }],
    ['parties.0.extra', { ...registry, parties: [{ ...party, extra: true }] }],
    ['parties.0.members.0.extra', { ...registry, parties: [{ ...party, members: [{ ...member, extra: true }] }] }],
    ['parties.0.id', { ...registry, parties: [{ ...party, id: 'red/green' }] }],
    ['parties.0.colour', { ...registry, parties: [{ ...party, colour: '#gg0000' }] }],
    ['parties.1.id', { ...registry, parties: [party, { ...party, members: [] }] }],
    ['parties.0.members.1.email', { ...registry, parties: [{ ...party, members: [member, { ...member, role: 'reader' }] }] }],
    ['parties.0.members.0.role', { ...registry, parties: [{ ...party, members: [{ ...member, role: 'admin' }] }] }],
  ] as const) {
    assert.throws(() => validateRegistry(value), { name: 'RegistryError', field }, field)
  }
})

function covers(pattern: string, channel: string): boolean {
  return pattern === '*' || pattern === channel || (pattern.endsWith('/') && channel.startsWith(pattern))
}

test('member and reader grants cannot exceed their role or reach another party', () => {
  for (const role of ['member', 'reader'] as const) {
    for (const board of ['repo', 'party'] as const) {
      for (const [pattern, permissions] of Object.entries(channelsFor(role, 'red', board))) {
        const where = `${role} on ${board}:${pattern}`
        for (const denied of ['label', 'manage', 'sync'] as const) {
          assert.ok(!permissions.includes(denied), `${where} grants ${denied}`)
        }
        if (role === 'reader') assert.ok(!permissions.includes('post'), where)
        if (board === 'party' && covers(pattern, 'config')) assert.ok(!permissions.includes('post'), where)
        assert.ok(!covers(pattern, 'party/green/inbox'), where)
        if (pattern.startsWith('party/')) assert.equal(pattern.split('/')[1], 'red', where)
      }
    }
  }
})

test('registry saves round-trip, reject invalid updates and replace without rewriting open readers', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-party-registry-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'parties.json')
  saveRegistry(file, registry)
  assert.deepEqual(loadRegistry(file), registry)

  const old = readFileSync(file, 'utf8')
  assert.throws(() => saveRegistry(file, { ...registry, parties: [party, party] }), RegistryError)
  assert.equal(readFileSync(file, 'utf8'), old)

  // A reader that opened the old file before replacement still sees the old bytes.
  const reader = openSync(file, 'r')
  try {
    const updated = { ...registry, parties: [] }
    saveRegistry(file, updated)
    assert.deepEqual(loadRegistry(file), updated)
    assert.equal(readFileSync(reader, 'utf8'), old)
  } finally {
    closeSync(reader)
  }
})
