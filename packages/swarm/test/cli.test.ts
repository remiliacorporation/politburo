import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { parse, stringify } from 'yaml'
import { defaultConfig } from '../src/config/load.ts'

function run(...args: string[]) {
  const result = spawnSync(process.execPath, ['src/cli.ts', ...args], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  return result
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('config show does not omit or misencode defaults in YAML or JSON', () => {
  const defaults = defaultConfig()
  const yaml = run('config', 'show')
  assert.equal(yaml.status, 0, yaml.stderr)
  assert.throws(() => JSON.parse(yaml.stdout), SyntaxError)
  assert.deepEqual(parse(yaml.stdout), defaults)

  const json = run('config', 'show', '--json')
  assert.equal(json.status, 0, json.stderr)
  assert.deepEqual(JSON.parse(json.stdout), defaults)
})

test('config show does not let party overrides beat repo or lose party-only values', (t) => {
  const dir = tempDir(t)
  const party = join(dir, 'party.yaml')
  const repo = join(dir, 'repo.json')
  const defaults = defaultConfig()
  const partyHours = defaults.claims.hours + 1
  const repoHours = partyHours + 1
  const spawners = defaults.names.spawners.slice().reverse()
  writeFileSync(party, stringify({ claims: { hours: partyHours }, names: { spawners } }))
  writeFileSync(repo, JSON.stringify({ claims: { hours: repoHours } }))

  const result = run('config', 'show', '--json', '--party', party, '--repo', repo)
  assert.equal(result.status, 0, result.stderr)
  const tree = JSON.parse(result.stdout)
  assert.equal(tree.claims.hours, repoHours)
  assert.deepEqual(tree.names.spawners, spawners)
})

test('config validate rejects an unknown field and does not hide its dotted path', (t) => {
  const party = join(tempDir(t), 'party.yaml')
  writeFileSync(party, stringify({ claims: { houres: true } }))

  const result = run('config', 'validate', '--party', party)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /^error: claims\.houres: [^\n]+\n$/)
})

test('config validate does not report a cyclic YAML alias as a config error', (t) => {
  const party = join(tempDir(t), 'party.yaml')
  writeFileSync(party, 'claims: &self\n  dock: *self\n')

  const result = run('config', 'validate', '--json', '--party', party)
  assert.equal(result.status, 1)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), { valid: false, field: '', message: 'aliases are not allowed' })
})

test('config validate leaks terminal control characters from an unknown key', (t) => {
  const party = join(tempDir(t), 'party.json')
  writeFileSync(party, JSON.stringify({ claims: { 'bad\x1b\n\x7f\x9b': true } }))

  const result = run('config', 'validate', '--party', party)
  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stderr.slice(0, -1), /[\x00-\x1f\x7f-\x9f]/)
  assert.match(result.stderr, /^error: claims\.bad\\u001b\\u000a\\u007f\\u009b:/)
})

test('config validate reports valid without requiring files', () => {
  const result = run('config', 'validate')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'valid\n')
})

test('an unknown command exits as misuse, not as a runtime error', () => {
  assert.equal(run('unknown').status, 2)
})
