import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  allocateMobSpecies, allocateSecretaryName, allocateSerial, allocateSpawnerName, allocateSpriteItem, loadConfig,
} from '../src/index.ts'

const cwd = new URL('../', import.meta.url)

function tempDir(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-alloc-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function node(args: string[], env?: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 5000, env })
  if (result.error) throw result.error
  return result
}

function run(args: string[], env?: NodeJS.ProcessEnv) {
  return node(['src/cli.ts', 'alloc', ...args], env)
}

function atClaimTwo(dir: string, fault: 'race' | 'kill') {
  return node(['--input-type=module', '-e', `
    import { spawnSync } from 'node:child_process'
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    import { join } from 'node:path'
    const [dir, fault] = process.argv.slice(1)
    const claim = join(dir, 'serials', '2')
    const write = fs.writeFileSync
    // Keep the real filesystem and inject the fault at the claim write boundary.
    fs.writeFileSync = (path, ...args) => {
      if (path === claim && fault === 'race') {
        const other = spawnSync(process.execPath, ['src/cli.ts', 'alloc', 'serial', '--dir', dir], {
          encoding: 'utf8', timeout: 3000,
        })
        if (other.error) throw other.error
        if (other.status !== 0) throw new Error(other.stderr || 'competing allocator failed')
        process.stdout.write(other.stdout)
      }
      write(path, ...args)
      if (path === claim && fault === 'kill') process.kill(process.pid, 'SIGKILL')
    }
    syncBuiltinESMExports()
    const { allocateSerial } = await import('./src/index.ts')
    console.log(allocateSerial(dir))
  `, dir, fault])
}

async function collect(child: ChildProcess) {
  let stdout = ''
  let stderr = ''
  child.stdout!.setEncoding('utf8').on('data', (text) => { stdout += text })
  child.stderr!.setEncoding('utf8').on('data', (text) => { stderr += text })
  const [status, signal] = await once(child, 'close')
  return { status, signal, stdout, stderr }
}

test('concurrent CLI allocations duplicate or skip serials or leave the live counter behind', async (t) => {
  const dir = tempDir(t)
  const counter = join(dir, 'mob-serial.txt')
  writeFileSync(counter, '4200\n')
  const results = await Promise.all(Array.from({ length: 100 }, () => collect(spawn(
    process.execPath, ['src/cli.ts', 'alloc', 'serial', '--dir', dir, '--json'], { cwd, timeout: 30000 },
  ))))
  const serials = results.map(({ status, signal, stderr, stdout }) => {
    assert.equal(status, 0, stderr || `child exited on ${signal}`)
    return JSON.parse(stdout).serial
  })
  assert.equal(new Set(serials).size, 100)
  assert.deepEqual(serials.sort((a, b) => a - b), Array.from({ length: 100 }, (_, i) => 4201 + i))
  assert.equal(readFileSync(counter, 'utf8'), '4300\n')
})

test('SIGKILL after a claim does not block the next writer or let it reuse the claim', (t) => {
  const dir = tempDir(t)
  assert.equal(allocateSerial(dir), 1)
  const counter = join(dir, 'mob-serial.txt')
  const child = atClaimTwo(dir, 'kill')
  assert.equal(child.signal, 'SIGKILL', child.stderr || 'did not reach the post-claim crash point')
  assert.equal(readFileSync(counter, 'utf8'), '1\n')
  const survivor = run(['serial', '--dir', dir])
  assert.equal(survivor.status, 0, survivor.stderr)
  assert.equal(survivor.stdout, '3\n')
  assert.equal(readFileSync(counter, 'utf8'), '3\n')
})

test('two writers that choose the same serial cannot both return it', (t) => {
  const dir = tempDir(t)
  assert.equal(allocateSerial(dir), 1)
  const result = atClaimTwo(dir, 'race')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '2\n3\n')
})

test('a counter reader opened before allocation sees a whole, unchanged version', (t) => {
  const dir = tempDir(t)
  const counter = join(dir, 'mob-serial.txt')
  writeFileSync(counter, '999\n')
  const reader = openSync(counter, 'r')
  try {
    assert.equal(allocateSerial(dir), 1000)
    assert.equal(readFileSync(reader, 'utf8'), '999\n')
    assert.equal(readFileSync(counter, 'utf8'), '1000\n')
  } finally {
    closeSync(reader)
  }
})

test('a malformed live counter is overwritten or issues a claim', (t) => {
  const dir = tempDir(t)
  const counter = join(dir, 'mob-serial.txt')
  writeFileSync(counter, 'abc')
  const { status, stderr, stdout } = run(['serial', '--dir', dir, '--json'])
  assert.equal(status, 1)
  assert.match(stderr, /^error: /)
  assert.ok(stderr.includes(counter))
  assert.equal(stdout, '')
  assert.equal(readFileSync(counter, 'utf8'), 'abc')
  writeFileSync(counter, '0\n')
  const repaired = run(['serial', '--dir', dir])
  assert.equal(repaired.status, 0, repaired.stderr)
  assert.equal(repaired.stdout, '1\n')
})

test('an out-of-band counter advance is ignored by the next allocation', (t) => {
  const dir = join(tempDir(t), 'new-dir')
  assert.equal(allocateSerial(dir), 1)
  writeFileSync(join(dir, 'mob-serial.txt'), '9000\n')
  assert.equal(allocateSerial(dir), 9001)
  assert.equal(readFileSync(join(dir, 'mob-serial.txt'), 'utf8'), '9001\n')
})

test('a claim ahead of the counter is reissued or skipped over incorrectly', (t) => {
  const dir = tempDir(t)
  assert.equal(allocateSerial(dir), 1)
  // A killed writer can leave a claim without updating the live counter.
  writeFileSync(join(dir, 'serials', '10'), '')
  assert.equal(allocateSerial(dir), 11)
  assert.equal(readFileSync(join(dir, 'mob-serial.txt'), 'utf8'), '11\n')
})

test('serial CLI ignores SWARM_SERIAL_DIR or accepts a missing directory', (t) => {
  const missing = run(['serial'], {})
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /^error: .*--dir/)
  const result = run(['serial'], { SWARM_SERIAL_DIR: tempDir(t) })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '1\n')
})

test('spawner or secretary allocation ignores the first free configured name', () => {
  const config = loadConfig()
  assert.equal(allocateSpawnerName(config, new Set(['ZAVOD', 'KOMBINAT'])), 'FABRIKA')
  assert.equal(allocateSecretaryName(config, new Set(['Peggy', 'Dawn'])), 'Joan')
})

test('name CLI ignores a party pool replacement or repo override', (t) => {
  const dir = tempDir(t)
  const party = join(dir, 'party.yaml')
  const repo = join(dir, 'repo.json')
  writeFileSync(party, 'names:\n  spawners: [CUSTOM, ALTERNATE, ZAVOD]\n')
  writeFileSync(repo, JSON.stringify({ names: { spawners: ['REPO'] } }))
  const args = ['name', 'spawner', '--in-use', 'CUSTOM,ZAVOD', '--party', party]
  const plain = run(args)
  assert.equal(plain.status, 0, plain.stderr)
  assert.equal(plain.stdout, 'ALTERNATE\n')
  const json = run([...args, '--repo', repo, '--json'])
  assert.equal(json.status, 0, json.stderr)
  assert.deepEqual(JSON.parse(json.stdout), { name: 'REPO' })
})

test('an exhausted spawner or secretary pool returns a name or hides which pool ran out', () => {
  const config = loadConfig({ party: { names: { spawners: ['CUSTOM'], secretaries: ['PERSON'] } } })
  assert.throws(() => allocateSpawnerName(config, new Set(['CUSTOM'])), /spawner name pool is exhausted/)
  assert.throws(() => allocateSecretaryName(config, new Set(['PERSON'])), /secretary name pool is exhausted/)
})

test('mob allocation adds a suffix too early or skips the next free number', () => {
  const config = loadConfig()
  assert.equal(allocateMobSpecies(config, 'audit', new Set(['COW2'])), 'SHEEP')
  const used = new Set(['COW', 'SHEEP', 'MOOSH', 'CHICKEN', 'PIG'])
  assert.equal(allocateMobSpecies(config, 'audit', used), 'COW2')
  used.add('COW2')
  used.add('COW4')
  assert.equal(allocateMobSpecies(config, 'audit', used), 'COW3')
  assert.equal(allocateMobSpecies(config, 'build', new Set(['BEE'])), 'DOLPHIN')
  assert.equal(allocateMobSpecies(config, 'merge', new Set(['GUARDIAN'])), 'SHULKER')
  assert.equal(allocateMobSpecies(config, 'boss', new Set(['DRAGON'])), 'WITHER')
})

test('sprite allocation skips a free configured item or returns an occupied item', () => {
  const config = loadConfig({ party: { names: { sprite_items: { implement: ['CHISEL', 'SAW'] } } } })
  assert.equal(allocateSpriteItem(config, 'implement', new Set(['CHISEL'])), 'SAW')
  assert.equal(allocateSpriteItem(config, 'implement', new Set(['CHISEL', 'CHISEL2', 'SAW'])), 'CHISEL3')
})

test('unknown jobs are accepted or expose pool contents in their errors', () => {
  const config = loadConfig()
  assert.throws(() => allocateMobSpecies(config, 'typo', []), { message: 'unknown mob job typo' })
  assert.throws(() => allocateSpriteItem(config, 'constructor', []), { message: 'unknown sprite job constructor' })
})

test('invalid in-use names are accepted or coerced instead of rejected', () => {
  const config = loadConfig()
  assert.throws(() => allocateSpawnerName(config, [123 as unknown as string]), TypeError)
  assert.throws(() => allocateSecretaryName(config, ['bad\0name']), RangeError)
  assert.throws(() => allocateMobSpecies(config, 'boss', ['bad\u202ename']), RangeError)
  assert.throws(() => allocateSpriteItem(config, 'docs', ['bad\u{e0001}name']), RangeError)
})
