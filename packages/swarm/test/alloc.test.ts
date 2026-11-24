import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  allocateMobSpecies, allocateSecretaryName, allocateSerial, allocateSpawnerName, allocateSpriteItem, loadConfig,
} from '../src/index.ts'

const cwd = new URL('../', import.meta.url)

function tempDir(t: TestContext) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'swarm-alloc-'))
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

function patchedSerial(dir: string, fault: string, ...paths: string[]) {
  return node(['--input-type=module', '-e', `
    import { spawnSync } from 'node:child_process'
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    import { join } from 'node:path'
    const [dir, fault, link, target] = process.argv.slice(1)
    const claim = join(dir, 'serials', '2')
    const realClaim = join(fs.realpathSync(dir), 'serials', '2')
    const counter = join(dir, 'mob-serial.txt')
    const claimCreate = (path, flags) => flags === 'wx' && (
      path === claim || path === realClaim || /^\\/proc\\/self\\/fd\\/\\d+\\/2$/.test(String(path))
    )
    const write = fs.writeFileSync
    const rename = fs.renameSync
    const open = fs.openSync
    const mkdir = fs.mkdirSync
    let claimFd
    let failure
    function compete(expected) {
      const other = spawnSync(process.execPath, ['src/cli.ts', 'alloc', 'serial', '--dir', dir], {
        encoding: 'utf8', timeout: 4500,
      })
      if (other.status !== 0 || other.stdout !== expected) {
        failure = other.error || new Error(other.stderr || 'competing allocator did not claim ' + expected)
        throw failure
      }
      return other.stdout
    }
    // Keep the real filesystem; inject faults at the claim, write, and publish boundaries.
    fs.mkdirSync = (path, ...args) => {
      const result = mkdir(path, ...args)
      if (path === link && fault === 'symlink-claims') {
        fs.rmdirSync(link)
        fs.symlinkSync(target, link)
      }
      return result
    }
    fs.openSync = (path, ...args) => {
      const creating = claimCreate(path, args[0])
      if (creating && fault === 'race') process.stdout.write(compete('2\\n'))
      // Swap serials/ for a symlink after the directory fd is held, before the claim create.
      if (args[0] === 'wx' && fault === 'swap-held' && /^\\/proc\\/self\\/fd\\/\\d+\\/\\d+$/.test(String(path))) {
        fs.renameSync(link, link + '.held')
        fs.symlinkSync(target, link)
      }
      const fd = open(path, ...args)
      if (creating) claimFd = fd
      return fd
    }
    fs.writeFileSync = (path, ...args) => {
      const isClaim = path === claimFd
      const isMirror = String(path).includes('.mob-serial-')
      if ((isClaim && fault === 'claim-enospc') || (isMirror && fault === 'enospc')) {
        if (isMirror) write(path, '2', args[1]) // ENOSPC can leave a partially written temp file.
        const error = new Error('ENOSPC: no space left on device')
        error.code = 'ENOSPC'
        throw error
      }
      write(path, ...args)
      if (isClaim && fault === 'kill') process.kill(process.pid, 'SIGKILL')
      if (isMirror && fault === 'kill-mirror') process.kill(process.pid, 'SIGKILL')
      if (isClaim && fault === 'retarget') {
        fs.unlinkSync(link)
        fs.symlinkSync(target, link)
      }
      if ((isClaim && fault === 'malformed') || (isMirror && fault === 'late-malformed')) write(counter, 'broken')
    }
    fs.renameSync = (from, to) => {
      if (to === counter) {
        if (fault === 'rename-fails') throw new Error('injected rename failure')
        if (fault === 'publish' || fault === 'publish-contended') {
          const staged = Number(fs.readFileSync(from, 'utf8'))
          // Publish a peer's higher serial just before the stale rename. Stop after six
          // peers so an uncapped writer also finishes, but leaves a different counter.
          if (staged === 2 || (fault === 'publish-contended' && staged < 8)) compete((staged + 1) + '\\n')
        }
      }
      rename(from, to)
    }
    syncBuiltinESMExports()
    const { allocateSerial } = await import('./src/index.ts')
    const serial = allocateSerial(dir)
    // Don't let the best-effort mirror catch hide a test failure.
    if (failure) throw failure
    console.log(serial)
  `, dir, fault, ...paths])
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
  const distinct = new Set(serials).size
  const finalCounter = readFileSync(counter, 'utf8')
  assert.equal(distinct, 100)
  assert.deepEqual(serials.sort((a, b) => a - b), Array.from({ length: 100 }, (_, i) => 4201 + i))
  assert.equal(finalCounter, '4300\n')
  t.diagnostic(`${results.length} children, ${distinct} distinct serials ${serials[0]}..${serials.at(-1)}, counter ${finalCounter.trim()}`)
})

test('SIGKILL after a claim does not block the next writer or let it reuse the claim', (t) => {
  const dir = tempDir(t)
  assert.equal(allocateSerial(dir), 1)
  const counter = join(dir, 'mob-serial.txt')
  const child = patchedSerial(dir, 'kill')
  assert.equal(child.signal, 'SIGKILL', child.stderr || 'did not reach the post-claim crash point')
  assert.equal(readFileSync(counter, 'utf8'), '1\n')
  const survivor = run(['serial', '--dir', dir])
  assert.equal(survivor.status, 0, survivor.stderr)
  assert.equal(survivor.stdout, '3\n')
  assert.equal(readFileSync(counter, 'utf8'), '3\n')
})

test('a SIGKILLed allocator leaves a lock file in the dir', (t) => {
  const dir = tempDir(t)
  assert.equal(allocateSerial(dir), 1)
  const child = patchedSerial(dir, 'kill-mirror')
  assert.equal(child.signal, 'SIGKILL', child.stderr || 'did not reach the mirror write')
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith('.counter.lock')), [])
})

test('a full disk during the mirror write fails the allocation or burns the serial', (t) => {
  const dir = tempDir(t)
  assert.equal(allocateSerial(dir), 1)
  const result = patchedSerial(dir, 'enospc')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '2\n')
  assert.deepEqual(readdirSync(dir).sort(), ['mob-serial.txt', 'serials'])
  const next = run(['serial', '--dir', dir])
  assert.equal(next.status, 0, next.stderr)
  assert.equal(next.stdout, '3\n')
})

test('a full disk writing claim metadata still returns the claimed serial', (t) => {
  const dir = tempDir(t)
  assert.equal(allocateSerial(dir), 1)
  const result = patchedSerial(dir, 'claim-enospc')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '2\n')
  assert.equal(readFileSync(join(dir, 'serials', '2'), 'utf8'), '')
  assert.equal(allocateSerial(dir), 3)
})

test('a --dir ancestor retarget splits the mirror from serials/ or causes an alias to reuse a serial', (t) => {
  const root = tempDir(t)
  const real = join(root, 'real')
  const nested = join(real, 'nested')
  const other = join(root, 'other')
  mkdirSync(nested, { recursive: true })
  mkdirSync(join(other, 'nested'), { recursive: true })
  const counter = join(nested, 'mob-serial.txt')
  writeFileSync(counter, '1\n')
  const ancestor = join(root, 'via')
  const alias = join(root, 'alias')
  symlinkSync(real, ancestor)
  symlinkSync(nested, alias)
  const first = patchedSerial(join(ancestor, 'nested'), 'retarget', ancestor, other)
  assert.equal(first.status, 0, first.stderr)
  assert.equal(first.stdout, '2\n')
  assert.ok(readdirSync(join(nested, 'serials')).includes('2'))
  assert.equal(readFileSync(counter, 'utf8'), '2\n')
  assert.deepEqual(readdirSync(join(other, 'nested')), [])
  const second = run(['serial', '--dir', alias])
  assert.equal(second.status, 0, second.stderr)
  assert.equal(second.stdout, '3\n')
  assert.equal(readFileSync(counter, 'utf8'), '3\n')
})

test('two writers that choose the same serial cannot both return it', (t) => {
  const dir = tempDir(t)
  assert.equal(allocateSerial(dir), 1)
  const result = patchedSerial(dir, 'race')
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
  assert.deepEqual(readdirSync(dir), ['mob-serial.txt'])
  writeFileSync(counter, '0\n')
  const repaired = run(['serial', '--dir', dir])
  assert.equal(repaired.status, 0, repaired.stderr)
  assert.equal(repaired.stdout, '1\n')
})

test('an out-of-order publish leaves the mirror behind the highest claim', (t) => {
  const dir = tempDir(t)
  assert.equal(allocateSerial(dir), 1)
  const result = patchedSerial(dir, 'publish')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '2\n')
  assert.equal(readFileSync(join(dir, 'mob-serial.txt'), 'utf8'), '3\n')
})

test('a contended mirror stops after five publish rounds', (t) => {
  const dir = tempDir(t)
  assert.equal(allocateSerial(dir), 1)
  const result = patchedSerial(dir, 'publish-contended')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '2\n')
  assert.equal(readFileSync(join(dir, 'mob-serial.txt'), 'utf8'), '6\n')
  assert.deepEqual(readdirSync(join(dir, 'serials')).sort(), ['1', '2', '3', '4', '5', '6', '7'])
  assert.equal(allocateSerial(dir), 8)
  assert.equal(readFileSync(join(dir, 'mob-serial.txt'), 'utf8'), '8\n')
})

for (const [fault, expected] of [['malformed', 'broken'], ['late-malformed', 'broken'], ['rename-fails', '1\n']] as const) {
  test(`a ${fault} mirror fault loses the claimed serial or alters the counter`, (t) => {
    const dir = tempDir(t)
    assert.equal(allocateSerial(dir), 1)
    const result = patchedSerial(dir, fault)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '2\n')
    assert.equal(readFileSync(join(dir, 'mob-serial.txt'), 'utf8'), expected)
  })
}

for (const name of ['serials', 'mob-serial.txt']) {
  test(`unsafe ${name} path is accepted or written through`, (t) => {
    const dir = tempDir(t)
    const target = tempDir(t)
    const path = join(dir, name)
    symlinkSync(name === 'serials' ? target : join(target, name), path)
    assert.throws(() => allocateSerial(dir), (error: Error) => error.message.includes(path))
    assert.deepEqual(readdirSync(dir), [name])
    assert.deepEqual(readdirSync(target), [])
  })
}

test('serials/ swapped after the directory is opened does not write outside --dir', (t) => {
  const dir = tempDir(t)
  const target = tempDir(t)
  const claims = join(dir, 'serials')
  const result = patchedSerial(dir, 'swap-held', claims, target)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '1\n')
  assert.deepEqual(readdirSync(target), [])
  assert.deepEqual(readdirSync(`${claims}.held`), ['1'])
})

test('serials/ swapped for a symlink after lstat is refused without writing outside --dir', (t) => {
  const dir = tempDir(t)
  const target = tempDir(t)
  const claims = join(dir, 'serials')
  const result = patchedSerial(dir, 'symlink-claims', claims, target)
  assert.deepEqual(readdirSync(target), [])
  assert.equal(result.status, 1, result.stderr)
  assert.equal(result.stdout, '')
  assert.ok(result.stderr.includes(`symlink refused: ${claims}`))
  assert.deepEqual(readdirSync(dir), ['serials'])
})

test('stray claim names inflate the next serial or wedge allocation', (t) => {
  const dir = tempDir(t)
  const claims = join(dir, 'serials')
  mkdirSync(claims)
  for (const name of ['3', '0007', '1e3', '99999999999999999999', 'tmp-9']) writeFileSync(join(claims, name), '')
  assert.equal(allocateSerial(dir), 4)
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

test('name CLI ignores repeated --in-use flags or configured pool overrides', (t) => {
  const dir = tempDir(t)
  const party = join(dir, 'party.yaml')
  const repo = join(dir, 'repo.json')
  writeFileSync(party, 'names:\n  spawners: [CUSTOM, ZAVOD, ALTERNATE]\n')
  writeFileSync(repo, JSON.stringify({ names: { spawners: ['REPO'] } }))
  const args = ['name', 'spawner', '--in-use', 'CUSTOM', '--in-use', 'ZAVOD', '--party', party]
  const plain = run(args)
  assert.equal(plain.status, 0, plain.stderr)
  assert.equal(plain.stdout, 'ALTERNATE\n')
  const json = run([...args, '--repo', repo, '--json'])
  assert.equal(json.status, 0, json.stderr)
  assert.deepEqual(JSON.parse(json.stdout), { name: 'REPO' })
})

test('name CLI prints output or succeeds with unsafe pool or --in-use names', (t) => {
  const party = join(tempDir(t), 'party.json')
  for (const bad of ['A\u001bB', 'A\u202eB', 'A\u00a0B', 'A,B']) {
    writeFileSync(party, JSON.stringify({ names: { spawners: ['SAFE', bad] } }))
    for (const flags of [['--in-use', bad], ['--in-use', '', '--party', party]]) {
      const result = run(['name', 'spawner', ...flags])
      assert.equal(result.status, 1, JSON.stringify({ bad, flags, ...result }))
      assert.match(result.stderr, /^error: [^\n]+\n$/)
      assert.equal(result.stdout, '')
    }
  }
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
