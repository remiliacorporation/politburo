import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { helpText, usageText } from '../src/cli-usage.ts'
import { loadCommands } from '../src/commands/load.ts'

function swarm(...args: string[]) {
  const result = spawnSync(process.execPath, ['src/cli.ts', ...args], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
  })
  if (result.error) throw result.error
  return result
}

const run = (...args: string[]) => swarm('work', ...args)

const catalogLines = [
  'usage: swarm config <show|validate> [--json] [--party FILE] [--repo FILE]',
  '       swarm ledger <dispatch|append|rollup> --db FILE [options]',
  '       swarm party <list|show|add|remove|member|jockey> ...',
  '       registry file: --registry FILE or SWARM_REGISTRY',
  '       swarm score <leaderboard|card|history|drill> ...',
  '       swarm trackers scan <repo> [--party FILE] [--repo FILE] [--json]',
  '       swarm trackers beads queue --epic ID --store-name NAME (--dir DIR | --fixture FILE) [--bd PATH] [--json]',
  '       swarm tags check [--registry FILE] [--json]',
  '       swarm skills sync --dir DIR [--party FILE] [--repo FILE] [--dry-run] [--force] [--json]',
  '       swarm sprite routes [--party FILE] [--repo FILE]',
  '       swarm capture <run|collect>',
  '       swarm mirror sync --repo owner/name [--json]',
  '       swarm overlap <work-id> --work FILE [--max-age-minutes N] [--json]',
  '       swarm rollout <add|notify|ack|stale|show> [--dir D] [--json]',
  '       swarm alloc serial [--dir DIR] [--json]',
  '       swarm alloc name <spawner|secretary|species|item> [JOB]',
  '         --in-use NAME [--in-use NAME ...] [--json] [--party FILE] [--repo FILE]',
  '       swarm classifier report <dir> [--json]',
  '       swarm classifier clear <dir> <question> --why TEXT',
  '       swarm serve --help',
]

function assertCatalogLines(text: string) {
  for (const line of catalogLines) assert.ok(text.includes(line), line)
}

async function assembledUsage() {
  const commands = await loadCommands()
  const config = commands.find((command) => command.name === 'config')
  const work = commands.find((command) => command.name === 'work')
  const configLine = config?.usage[0]
  const workLine = work?.usage[0]
  assert.ok(configLine, 'config must publish a usage line')
  assert.ok(workLine, 'work must publish a usage line')
  return {
    catalog: `${usageText(commands)}\n`,
    help: `${helpText(commands)}\n`,
    configLine,
    workLine,
  }
}

test('config help must print each catalog command and not work usage', async () => {
  const expected = await assembledUsage()
  const result = swarm('config', '--help')
  assert.equal(result.status, 0)
  assert.equal(result.stdout, expected.catalog)
  assertCatalogLines(result.stdout)
  assert.equal(result.stderr, '')
  assert.ok(result.stdout.includes(expected.configLine))
  assert.equal(result.stdout.includes(expected.workLine), false)
  assert.doesNotMatch(result.stdout, /swarm work /)
})

test('config misuse must not append work usage to the catalog diagnostic', async () => {
  const expected = await assembledUsage()
  const result = swarm('config', 'bogus')
  assert.equal(result.status, 2)
  assert.equal(result.stderr, `error: unknown config command bogus\n${expected.catalog}`)
  assertCatalogLines(result.stderr)
  assert.equal(result.stderr.includes(expected.workLine), false)
  assert.doesNotMatch(result.stderr, /swarm work /)
})

test('swarm --help must print the assembled catalog and each help-only command', async () => {
  const expected = await assembledUsage()
  const result = swarm('--help')
  assert.equal(result.status, 0)
  assert.equal(result.stdout, expected.help)
  assert.ok(result.stdout.startsWith(expected.catalog))
  assertCatalogLines(result.stdout)
  assert.ok(result.stdout.includes(expected.configLine))
  assert.ok(result.stdout.includes(expected.workLine))
})

function description(t: TestContext, text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-work-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'ticket.md')
  writeFileSync(file, text)
  return file
}

test('work check must accept the documented contract in plain text and JSON', t => {
  const design = readFileSync(new URL('../../../design/swarm-work-items.md', import.meta.url), 'utf8')
  const text = /```markdown\n(## Acceptable outcomes\n[\s\S]*?)\n```/.exec(design)?.[1]
  assert.ok(text)
  const file = description(t, text)
  const plain = run('check', file)
  assert.equal(plain.status, 0, plain.stderr)
  assert.equal(plain.stdout, 'valid\n')
  const json = run('check', file, '--json')
  assert.equal(json.status, 0, json.stderr)
  assert.deepEqual(JSON.parse(json.stdout), { valid: true, problems: [] })
})

test('work check must fail with a problem when the outcomes marker is missing', t => {
  const file = description(t, 'Work on it')
  const plain = run('check', file)
  assert.equal(plain.status, 1)
  assert.match(plain.stdout, /^[^\n]*outcomes marker[^\n]*\n$/i)
  const json = run('check', file, '--json')
  assert.equal(json.status, 1)
  const { valid, problems } = JSON.parse(json.stdout)
  assert.equal(valid, false)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /outcomes marker/i)
})

test('work check must reject a file over 21,000 bytes even when its contract text is valid', t => {
  const design = readFileSync(new URL('../../../design/swarm-work-items.md', import.meta.url), 'utf8')
  const text = /```markdown\n(## Acceptable outcomes\n[\s\S]*?)\n```/.exec(design)?.[1]
  assert.ok(text)
  const file = description(t, `${'é'.repeat(11_000)}\n\n${text}`)
  const result = run('check', file, '--json')
  assert.equal(result.status, 1)
  assert.deepEqual(JSON.parse(result.stdout), {
    valid: false, problems: ['The description must be text of at most 20,000 characters.'],
  })
})

test('an unreadable work check file with --json must produce one failure document', t => {
  const file = description(t, '')
  rmSync(file)
  const result = run('check', file, '--json')
  assert.equal(result.status, 1)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), { valid: false, problems: [`cannot read ${file}`] })
})

test('unknown short flags must be misuse rather than a file or tag lookup', () => {
  for (const args of [['check', '-x'], ['id', '-x', '--after', '1']]) {
    const result = run(...args)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /\nusage: swarm work check FILE/)
  }
})

test('work id must advance the high-water number and lowercase the tag', () => {
  const result = run('id', 'PLB', '--after', '481')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'plb-482\n')
})

test('work id must not allocate for an unregistered tag', () => {
  const result = run('id', 'ZZZ', '--after', '481')
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^error: unknown work tag\n$/)
})

test('work id must read the registry file given with --registry', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-work-registry-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'tags.json')
  writeFileSync(file, JSON.stringify({ tags: [{ tag: 'zzz', project: 'Temp' }] }))
  const result = run('id', 'zzz', '--after', '1', '--registry', file)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'zzz-2\n')
})
