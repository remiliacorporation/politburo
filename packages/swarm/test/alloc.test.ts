import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs'
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

function run(args: string[], env?: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, ['src/cli.ts', 'alloc', ...args], {
    cwd, encoding: 'utf8', timeout: 5000, env,
  })
  if (result.error) throw result.error
  return result
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

test('SIGKILL during allocation blocks the next writer or lets it reuse a claim', async (t) => {
  const dir = tempDir(t)
  const claims = join(dir, 'serials')
  let last = allocateSerial(dir)
  assert.equal(last, 1)
  const returned = new Set([last])
  for (let i = 0; i < 3; i++) {
    // Kill a busy allocator as soon as we observe it creating a claim. The next
    // writer continues against the very same files, without any cleanup.
    let interrupted = false
    const watcher = watch(claims, (event, name) => {
      if (event === 'rename' && name === String(last + 1)) interrupted = child.kill('SIGKILL') || interrupted
    })
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { writeSync } from 'node:fs'
      import { allocateSerial } from './src/rollout/serial.ts'
      for (;;) writeSync(1, allocateSerial(process.argv[1]) + '\\n')
    `, dir], { cwd, timeout: 5000, killSignal: 'SIGKILL' })
    try {
      const { signal, stdout, stderr } = await collect(child)
      assert.equal(signal, 'SIGKILL', stderr)
      assert.ok(interrupted, 'did not observe a claim before killing the allocator')
      for (const line of stdout.trim().split('\n').filter(Boolean)) {
        assert.ok(!returned.has(Number(line)), `reused ${line}`)
        returned.add(Number(line))
      }
    } finally {
      watcher.close()
    }
    const highest = Math.max(...readdirSync(claims).map(Number))
    const survivor = run(['serial', '--dir', dir])
    assert.equal(survivor.status, 0, survivor.stderr)
    last = highest + 1
    assert.equal(survivor.stdout, `${last}\n`)
    assert.ok(!returned.has(last), `reused ${last}`)
    returned.add(last)
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
  assert.deepEqual(readdirSync(join(dir, 'serials')), [])
  assert.equal(readFileSync(counter, 'utf8'), 'abc')
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
