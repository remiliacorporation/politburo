import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

const skills = ['mob', 'mob-creation', 'policy', 'research', 'reviewer', 'spawner']
const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

function runSkillsWithEnv(spawnEnv: NodeJS.ProcessEnv, ...args: string[]) {
  const result = spawnSync(process.execPath, ['src/cli.ts', 'skills', ...args], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
    env: spawnEnv,
  })
  if (result.error) throw result.error
  return result
}

function runSkills(...args: string[]) {
  return runSkillsWithEnv(env, ...args)
}

function runWithEnv(spawnEnv: NodeJS.ProcessEnv, dir: string, ...flags: string[]) {
  return runSkillsWithEnv(spawnEnv, 'sync', '--dir', dir, ...flags)
}

function run(dir: string, ...flags: string[]) {
  return runWithEnv(env, dir, ...flags)
}

function install(dir: string, ...flags: string[]) {
  const result = run(dir, ...flags)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

function tempDir(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-skills-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function party(dir: string, config: unknown) {
  const path = join(dir, 'party.json')
  writeFileSync(path, JSON.stringify(config))
  return ['--party', path]
}

function species(build: string[]) {
  return { names: { mob_species: { neutral: { build } } } }
}

function filesUnder(dir: string) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name))
}

test('policy does not keep default review rounds, claim hours, or species after overrides', (t) => {
  const root = tempDir(t)
  const stock = join(root, 'default')
  const custom = join(root, 'custom')
  const build = ['HERON', 'OTTER']
  install(stock)
  install(custom, ...party(root, {
    ...species(build),
    review: { code: { review_rounds: 7, fix_rounds: 9 } },
    claims: { hours: 13 },
  }))
  const before = readFileSync(join(stock, 'policy/SKILL.md'), 'utf8')
  const after = readFileSync(join(custom, 'policy/SKILL.md'), 'utf8')
  assert.notEqual(before, after)
  // Compare the numbers in place without depending on the surrounding prose.
  const oldNumbers = before.match(/\b\d+\b/g) ?? []
  const newNumbers = after.match(/\b\d+\b/g) ?? []
  const changes = newNumbers.map((value, i) => [oldNumbers[i], value]).filter(([a, b]) => a !== b)
  assert.deepEqual(changes, [['1', '7'], ['1', '9'], ['4', '13']])
  for (const name of build) assert.ok(after.includes(name), `missing species ${name}`)
  for (const name of ['BEE', 'DOLPHIN']) {
    const word = new RegExp(`\\b${name}\\b`)
    assert.match(before, word)
    assert.doesNotMatch(after, word)
  }
})

test('sync does not install protected repo references from defaults or party config', (t) => {
  const root = tempDir(t)
  const stock = join(root, 'default')
  install(stock)
  for (const path of filesUnder(stock)) assert.doesNotMatch(readFileSync(path, 'utf8'), /tigeryard/i, path)
  const custom = join(root, 'custom')
  assert.equal(run(custom, ...party(root, species(['TiGeRyArD']))).status, 1)
  assert.ok(!existsSync(custom))
})

test('sync refuses references spelled with HTML numeric character references or percent-encoded letters', (t) => {
  const root = tempDir(t)
  const dir = join(root, 'skills')
  for (const name of ['&#84;igeryard', '%54igeryard']) {
    const { status, stderr } = run(dir, ...party(root, species([name])))
    assert.equal(status, 1, name)
    assert.match(stderr, /blocked reference/)
    assert.ok(!existsSync(dir))
  }
})

test('sync refuses a destination inside a checkout with a protected origin', (t) => {
  const checkout = tempDir(t)
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', 'https://example.test/acme/tigeryard.git']]) {
    const result = spawnSync('git', args, { cwd: checkout, encoding: 'utf8', env })
    assert.equal(result.status, 0, result.stderr)
  }
  const dir = join(checkout, 'nested', 'skills')
  const { status } = run(dir)
  assert.ok(status !== null && status !== 0, 'sync should exit with an error')
  assert.ok(!existsSync(join(checkout, 'nested')))
})

test('sync refuses a protected checkout when git discovery stops before its parent .git', (t) => {
  const root = tempDir(t)
  const checkout = join(root, 'checkout')
  mkdirSync(checkout)
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', 'https://example.test/acme/tigeryard.git']]) {
    const result = spawnSync('git', args, { cwd: checkout, encoding: 'utf8', env })
    assert.equal(result.status, 0, result.stderr)
  }
  const ceiling = join(checkout, 'nested')
  const dir = join(ceiling, 'skills')
  mkdirSync(dir, { recursive: true })
  // Inject the ceiling at the Git process boundary, after the CLI sanitizes its env.
  writeFileSync(join(root, 'git'), [
    '#!/bin/sh',
    'PATH=$SKILLS_TEST_GIT_PATH',
    'export PATH',
    'GIT_CEILING_DIRECTORIES=$SKILLS_TEST_CEILING exec git "$@"',
    '',
  ].join('\n'), { mode: 0o755 })
  const spawnEnv = { ...env, PATH: `${root}:${env.PATH}`, SKILLS_TEST_GIT_PATH: env.PATH, SKILLS_TEST_CEILING: ceiling }
  const discovery = spawnSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { encoding: 'utf8', env: spawnEnv })
  assert.equal(discovery.status, 128, discovery.stderr)
  assert.match(discovery.stderr, /not a git repository/)
  const { status, stderr } = runWithEnv(spawnEnv, dir)
  assert.equal(status, 1)
  assert.match(stderr, /protected git checkout/)
  assert.deepEqual(readdirSync(dir), [])

  rmSync(join(checkout, '.git'), { recursive: true })
  writeFileSync(join(checkout, '.git'), 'gitdir: missing\n')
  const broken = runWithEnv(spawnEnv, dir)
  assert.equal(broken.status, 1)
  assert.match(broken.stderr, /cannot check target git checkout/)
  assert.deepEqual(readdirSync(dir), [])
})

test('startup skill text does not reach 4,000 estimated tokens with defaults or a long pool', (t) => {
  const root = tempDir(t)
  const longPool = Array.from({ length: 200 }, (_, i) => `SPECIES_${i}`)
  for (const [name, flags] of [['default', []], ['long pool', party(root, species(longPool))]] as const) {
    const dir = join(root, name)
    install(dir, ...flags)
    const chars = skills.reduce((sum, skill) => sum + readFileSync(join(dir, skill, 'SKILL.md'), 'utf8').length, 0)
    assert.ok(chars / 4 < 4_000, `${name}: estimated ${chars / 4} startup tokens`)
  }
})

test('sync does not write on dry-run, omit skills, or report changes on repeat', (t) => {
  const dir = join(tempDir(t), 'skills')
  assert.match(install(dir, '--dry-run'), /^would write\s/m)
  assert.ok(!existsSync(dir))
  install(dir)
  assert.deepEqual(readdirSync(dir).sort(), skills)
  for (const skill of skills) assert.ok(filesUnder(join(dir, skill)).includes(join(dir, skill, 'SKILL.md')))
  assert.ok(existsSync(join(dir, 'mob-creation', 'brief-template.md')))
  const reported = install(dir).trimEnd().split('\n').map((line) => line.replace(/^unchanged\s+/, ''))
  assert.deepEqual(reported.sort(), filesUnder(dir).sort())
})

test('sync does not overwrite a hand-authored skill or write other files without --force', (t) => {
  const dir = tempDir(t)
  mkdirSync(join(dir, 'reviewer'))
  const path = join(dir, 'reviewer/SKILL.md')
  const original = '# Hand-authored reviewer\n'
  writeFileSync(path, original)
  const result = run(dir)
  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes(path))
  assert.deepEqual(readdirSync(dir), ['reviewer'])
  assert.deepEqual(filesUnder(dir), [path])
  assert.equal(readFileSync(path, 'utf8'), original)
  install(dir, '--force')
  assert.notEqual(readFileSync(path, 'utf8'), original)
  assert.deepEqual(readdirSync(dir).sort(), skills)
})

test('sync does not overwrite a hand-authored file that quotes the generated marker inside a code fence', (t) => {
  const dir = tempDir(t)
  mkdirSync(join(dir, 'reviewer'))
  const path = join(dir, 'reviewer/SKILL.md')
  const original = [
    '---',
    'name: reviewer',
    '---',
    '# Hand-authored reviewer',
    '',
    '```',
    '<!-- generated by swarm skills sync; edits are overwritten -->',
    '```',
    '',
  ].join('\n')
  writeFileSync(path, original)
  const result = run(dir)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /unmarked file/)
  assert.deepEqual(readdirSync(dir), ['reviewer'])
  assert.equal(readFileSync(path, 'utf8'), original)
})

test('sync rejects a name pool that pushes startup text over the token limit without writing', (t) => {
  const root = tempDir(t)
  const dir = join(root, 'skills')
  const pool = Array.from({ length: 10_000 }, (_, i) => `SPECIES_${i}`)
  assert.equal(run(dir, ...party(root, species(pool))).status, 1)
  assert.ok(!existsSync(dir) || readdirSync(dir).length === 0)
})

test('sync rejects startup text of exactly 4,000 estimated tokens without writing', (t) => {
  const root = tempDir(t)
  const baseline = join(root, 'baseline')
  install(baseline)
  const chars = skills.reduce((sum, skill) => sum + readFileSync(join(baseline, skill, 'SKILL.md'), 'utf8').length, 0)
  const name = 'S'.repeat(4000 * 4 - chars + 'BEE, DOLPHIN'.length)
  const dir = join(root, 'skills')
  const { status, stderr } = run(dir, ...party(root, species([name])))
  assert.equal(status, 1)
  assert.match(stderr, /startup text is 4000 tokens/)
  assert.ok(!existsSync(dir))
})

test('sync does not print newline-injected rows in paths or errors', (t) => {
  const dir = join(tempDir(t), 'x\ninjected')
  const stdout = install(dir, '--dry-run')
  assert.ok(stdout.includes('x\\u000ainjected'))
  assert.ok(!stdout.includes('\ninjected'))
  writeFileSync(dir, '')
  const { status, stderr } = run(dir)
  assert.equal(status, 1)
  assert.ok(stderr.includes('x\\u000ainjected'))
  assert.ok(!stderr.includes('\ninjected'))
})

test('json output does not print DEL or C1 control characters in paths unescaped', (t) => {
  const dir = join(tempDir(t), 'x\n\u007f\u0080\u009fy')
  const { status, stdout, stderr } = run(dir, '--dry-run', '--json')
  assert.equal(status, 0, stderr)
  assert.doesNotMatch(stdout, /[\x7f-\x9f]/)
  assert.ok(stdout.includes('x\\n\\u007f\\u0080\\u009fy'))
  const parsed = JSON.parse(stdout) as { files: { path: string }[] }
  assert.ok(parsed.files.some((file) => file.path === join(dir, 'reviewer', 'SKILL.md')))
})

test('sync rejects an unknown party field with an error and no writes', (t) => {
  const root = tempDir(t)
  const dir = join(root, 'skills')
  const result = run(dir, ...party(root, { claims: { houres: 17 } }))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /^error:/m)
  assert.ok(!existsSync(dir))
})

function plan(dir: string, { tag = 'plb', job = 'build' } = {}, ...flags: string[]) {
  return runSkills('plan-mob', '--skills', dir, '--tag', tag, '--job', job, '--serial', '280', ...flags)
}

test('plan-mob does not reuse live species or lose the serial in the ID and title', (t) => {
  const root = tempDir(t)
  const dir = join(root, 'skills')
  const flags = party(root, species(['HERON', 'OTTER']))
  install(dir, ...flags)
  for (const [live, mob] of [['HERON', '280-OTTER'], ['HERON,OTTER,HERON2', '280-HERON3']] as const) {
    const { status, stdout, stderr } = plan(dir, {}, ...flags, '--live', live, '--json')
    assert.equal(status, 0, stderr)
    const output = JSON.parse(stdout)
    assert.equal(output.mob, mob)
    assert.equal(output.title, `plb ${mob}`)
  }
})

test('plan-mob does not suffix sprite items before their pool is exhausted or accept an unknown sprite job', (t) => {
  const dir = tempDir(t)
  install(dir)
  const flags = Array.from({ length: 4 }, () => ['--sprite', 'review']).flat()
  const { status, stdout, stderr } = plan(dir, {}, ...flags, '--json')
  assert.equal(status, 0, stderr)
  const { mob, sprites } = JSON.parse(stdout)
  assert.deepEqual(sprites, ['SWORD', 'BOW', 'TRIDENT', 'SWORD2'].map((item) => `${mob}.${item}`))
  const unknown = plan(dir, {}, '--sprite', 'unknown-job')
  assert.equal(unknown.status, 1)
  assert.equal(unknown.stdout, '')
})

test('plan-mob does not miss live species with whitespace or numeric suffixes', (t) => {
  const dir = tempDir(t)
  install(dir)
  for (const [live, mob] of [['BEE, DOLPHIN', 'BEE2'], ['BEE2', 'DOLPHIN'], ['BEE2,DOLPHIN', 'BEE3']] as const) {
    const { status, stdout, stderr } = plan(dir, {}, '--live', live, '--json')
    assert.equal(status, 0, stderr)
    assert.equal(JSON.parse(stdout).mob, `280-${mob}`, live)
  }
})

test('plan-mob does not reject a numeric suffix on an eight-character species', (t) => {
  const root = tempDir(t)
  const dir = join(root, 'skills')
  const flags = party(root, species(['PILLAGER', 'OTTER']))
  install(dir, ...flags)
  const { status, stdout, stderr } = plan(dir, {}, ...flags, '--live', 'PILLAGER,OTTER', '--json')
  assert.equal(status, 0, stderr)
  assert.equal(JSON.parse(stdout).mob, '280-PILLAGER2')
})

test('plan-mob refuses species with embedded newlines or lowercase letters', (t) => {
  const dir = tempDir(t)
  install(dir)
  for (const name of ['BE\nE', 'bee']) {
    const { status, stdout, stderr } = plan(dir, {}, ...party(dir, species([name])))
    assert.equal(status, 1)
    assert.equal(stdout, '')
    assert.equal(stderr, 'error: invalid name in names.mob_species.neutral.build\n')
  }
})

for (const [label, text] of [
  ['a carriage return', '\r'], ['an escape', '\x1b'], ['a C1 control', '\x85'],
  ['a protected repo reference', 'TiGeRyArD'],
]) {
  test(`plan-mob refuses a template containing ${label} without echoing it`, (t) => {
    const dir = tempDir(t)
    install(dir)
    const path = join(dir, 'mob-creation/brief-template.md')
    writeFileSync(path, `${readFileSync(path, 'utf8')}${text}\n`)
    const { status, stdout, stderr } = plan(dir)
    assert.equal(status, 1)
    assert.equal(stdout, '')
    assert.match(stderr, /^error: (control character in brief template|protected repo reference in brief)\n$/)
    assert.doesNotMatch(stderr, /tigeryard/i)
  })
}

test('plan-mob does not let entity- or percent-encoded protected references through', (t) => {
  const dir = tempDir(t)
  install(dir)
  const path = join(dir, 'mob-creation/brief-template.md')
  const template = readFileSync(path, 'utf8')
  const attempts = ['&#84;igeryard', '%54igeryard'].map((text) => {
    writeFileSync(path, `${template}${text}\n`)
    return plan(dir)
  })
  assert.deepEqual(attempts.map(({ status }) => status), [1, 1])
  for (const { stdout, stderr } of attempts) {
    assert.equal(stdout, '')
    assert.equal(stderr, 'error: protected repo reference in brief\n')
  }
})

test('plan-mob does not emit an unusable brief or hash different bytes from what it prints', (t) => {
  const dir = tempDir(t)
  install(dir)
  const path = join(dir, 'mob-creation/brief-template.md')
  writeFileSync(path, `${readFileSync(path, 'utf8')}\tindented\n`)
  const { tags } = JSON.parse(readFileSync(new URL('../registry/tags.json', import.meta.url), 'utf8'))
  for (const { tag } of tags) {
    const { status, stdout, stderr } = plan(dir, { tag })
    assert.equal(status, 0, `${tag}: ${stderr}`)
    const split = stdout.indexOf('\n\n')
    assert.ok(split > 0, `${tag}: missing brief separator`)
    const header = stdout.slice(0, split)
    const brief = stdout.slice(split + 2)
    const mob = header.match(/^mob  (\S+)$/m)?.[1]
    assert.ok(mob && header.split('\n').includes(`title  ${tag} ${mob}`), `${tag}: missing mob or title`)
    assert.ok(brief.includes(mob), `${tag}: missing mob ID in brief`)
    assert.doesNotMatch(brief, /<<mob_id>>/, tag)
    assert.equal(header.match(/^brief  sha256:([a-f0-9]{64})$/m)?.[1],
      createHash('sha256').update(brief).digest('hex'), tag)
  }
})

test('plan-mob does not fall back when the installed brief template is missing or unmarked', (t) => {
  const dir = tempDir(t)
  install(dir)
  const path = join(dir, 'mob-creation', 'brief-template.md')
  rmSync(path)
  for (const template of ['missing', 'unmarked']) {
    if (template === 'unmarked') writeFileSync(path, 'Hand-authored brief\n')
    const { status, stderr } = plan(dir)
    assert.equal(status, 1, template)
    assert.match(stderr, /^error:/m, template)
  }
})

test('plan-mob reads the registry file given with --registry', (t) => {
  const dir = tempDir(t)
  install(dir)
  const registry = join(dir, 'tags.json')
  writeFileSync(registry, JSON.stringify({ tags: [{ tag: 'aaa', project: 'Temp' }] }))
  const missing = plan(dir, { tag: 'aaa' })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /^error: unknown tag aaa\n$/)
  const found = plan(dir, { tag: 'aaa' }, '--registry', registry, '--json')
  assert.equal(found.status, 0, found.stderr)
  assert.match(JSON.parse(found.stdout).title, /^aaa /)
})

test('plan-mob refuses boss jobs and unknown tags without output or writes', (t) => {
  const root = tempDir(t)
  const dir = join(root, 'skills')
  install(dir)
  const before = readdirSync(root, { recursive: true }).sort()
  for (const options of [{ job: 'boss' }, { tag: 'unknown-tag' }]) {
    const { status, stdout, stderr } = plan(dir, options)
    assert.equal(status, 1, JSON.stringify(options))
    assert.equal(stdout, '')
    assert.match(stderr, /^error:/m)
    assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before)
  }
})
