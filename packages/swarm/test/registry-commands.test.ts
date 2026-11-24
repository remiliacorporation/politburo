import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

function swarm(...args: string[]) {
  const result = spawnSync(process.execPath, ['src/cli.ts', ...args], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
  })
  if (result.error) throw result.error
  return result
}

function workspace(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-registry-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const skills = join(dir, 'skills')
  const installed = swarm('skills', 'sync', '--dir', skills)
  assert.equal(installed.status, 0, installed.stderr)
  return { dir, skills }
}

function plan(skills: string, registry: string, tag: string) {
  return swarm('skills', 'plan-mob', '--skills', skills, '--tag', tag, '--job', 'build', '--serial', '280',
    '--registry', registry, '--json')
}

test('tags check, work id, and plan-mob accept one registry, including tag case', (t) => {
  const { dir, skills } = workspace(t)
  const registry = join(dir, 'tags.yaml')
  writeFileSync(registry, 'tags:\n  - tag: zzz\n    project: Temp\n')

  const checked = swarm('tags', 'check', '--registry', registry)
  assert.equal(checked.status, 0, checked.stderr)
  assert.equal(checked.stdout, 'valid\n')

  const id = swarm('work', 'id', 'ZZZ', '--after', '481', '--registry', registry)
  assert.equal(id.status, 0, id.stderr)
  assert.equal(id.stdout, 'zzz-482\n')

  const planned = plan(skills, registry, 'ZZZ')
  assert.equal(planned.status, 0, planned.stderr)
  const title = (JSON.parse(planned.stdout) as { title: string }).title
  assert.match(title, /^zzz \S+$/)
  assert.doesNotMatch(title, /ZZZ/)
})

test('plan-mob names a tag in the same case work id allocates', (t) => {
  const { dir, skills } = workspace(t)
  const registry = join(dir, 'tags.json')
  writeFileSync(registry, JSON.stringify({ tags: [{ tag: 'plb', project: 'Temp' }] }))

  const id = swarm('work', 'id', 'PLB', '--after', '481', '--registry', registry)
  assert.equal(id.status, 0, id.stderr)
  assert.equal(id.stdout, 'plb-482\n')

  const planned = plan(skills, registry, 'PLB')
  assert.equal(planned.status, 0, planned.stderr)
  const body = JSON.parse(planned.stdout) as { title: string; brief: string }
  assert.match(body.title, /^plb \S+$/)
  assert.match(body.brief, /^-\s*repo:\s*plb$/m)
})

test('tags check, work id, and plan-mob reject a registry with a duplicate key', (t) => {
  const { dir, skills } = workspace(t)
  const registry = join(dir, 'tags.json')
  writeFileSync(registry, '{"tags":[{"tag":"abc","tag":"zzz","project":"Temp"}]}')

  const checked = swarm('tags', 'check', '--registry', registry)
  const id = swarm('work', 'id', 'zzz', '--after', '481', '--registry', registry)
  const planned = plan(skills, registry, 'zzz')
  assert.equal(checked.status, 1, checked.stdout)
  assert.notEqual(checked.stdout, 'valid\n')
  assert.equal(id.status, 1)
  assert.equal(id.stdout, '')
  assert.equal(planned.status, 1)
  assert.equal(planned.stdout, '')
  assert.match(planned.stderr, /^error: /)
})
