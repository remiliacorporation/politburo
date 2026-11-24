import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { pickName, namePool, spawnerTitle } from '../src/names.ts'

const expectedNames = [
  'ZAVOD', 'FABRIKA', 'KOMBINAT', 'KOLKHOZ', 'SOVKHOZ',
  'ARTEL', 'SHAKHTA', 'TSEKH', 'DOMNA', 'KOTLOVAN',
  'PRORAB', 'BRIGADIR', 'MASTER', 'NARKOM', 'UDARNIK', 'TREST', 'GLAVK',
  'GOSPLAN', 'NORMA', 'SMENA', 'OTDEL',
  'MOLOT', 'SERP', 'TRAKTOR', 'TURBINA', 'KRAN', 'STAL', 'GUDOK',
  'MAGNITKA', 'URALMASH', 'ZIL', 'GAZ', 'KAMAZ',
]

test('namePool lists unique uppercase ASCII names in allocation order', () => {
  assert.equal(new Set(namePool).size, namePool.length)
  for (const name of namePool) assert.match(name, /^[A-Z]{1,8}$/)
  assert.deepEqual(namePool, expectedNames)
})

test('the README name table lists the pool in allocation order', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  const namesSection = readme.split(/^## /m).find((section) => /^Names\r?\n/.test(section))
  assert.ok(namesSection, 'README has a Names section')
  const rows = namesSection.split(/\r?\n/).filter((line) => line.trimStart().startsWith('|'))
  const documented = rows.flatMap((row) => Array.from(row.matchAll(/`([^`]+)`/g), (entry) => entry[1]))
  assert.deepEqual(documented, namePool)
})

test('pickName starts at ZAVOD and follows the order as earlier names are taken', () => {
  for (const [index, name] of expectedNames.entries()) {
    assert.equal(pickName(expectedNames.slice(0, index)), name, `${index} names in use`)
  }
})

test('pickName skips used names even when they are not a prefix', () => {
  const inUse = new Set(['ZAVOD', 'KOMBINAT'])
  assert.equal(pickName(inUse), 'FABRIKA')
  assert.deepEqual(inUse, new Set(['ZAVOD', 'KOMBINAT']))
  inUse.add('FABRIKA')
  assert.equal(pickName(inUse), 'KOLKHOZ')
})

test('pickName accepts a one-shot iterable', () => {
  assert.equal(pickName(['ZAVOD', 'FABRIKA'].values()), 'KOMBINAT')
})

test('pickName takes the first name again once it is freed', () => {
  const inUse = new Set(['ZAVOD', 'FABRIKA'])
  assert.equal(pickName(inUse), 'KOMBINAT')
  inUse.delete('ZAVOD')
  assert.equal(pickName(inUse), 'ZAVOD')
})

test('pickName ignores unknown strings, including other spellings of pool names', () => {
  const inUse = ['UNKNOWN', 'zavod', ' ZAVOD', 'ZAVOD ']
  assert.equal(pickName(inUse), 'ZAVOD')
  assert.equal(pickName([...inUse, 'ZAVOD']), 'FABRIKA')
})

test('pickName reports exhaustion when every name is in use', () => {
  assert.throws(() => pickName(expectedNames), Error)
  assert.throws(() => pickName([...expectedNames, 'UNKNOWN']), Error)
  assert.equal(pickName(expectedNames.slice(1)), 'ZAVOD')
})

test('pickName counts pool names in use, not the size of the input', () => {
  const lastName = expectedNames[expectedNames.length - 1]
  assert.equal(pickName([...expectedNames.slice(0, -1), 'UNKNOWN']), lastName)
  assert.equal(pickName(new Set([...expectedNames.slice(0, -1), 'UNKNOWN'])), lastName)
})

test('duplicate in-use names do not exhaust the pool', () => {
  const used = expectedNames.slice(0, -1)
  assert.equal(pickName([...used, 'ZAVOD']), expectedNames.at(-1))
})

test('spawnerTitle and pickName reject control and format characters', () => {
  for (const invalid of ['R\0W', 'R\u0080W', 'R\u202eW', 'R\ufeffW', 'R\u{e0001}W']) {
    const label = `U+${invalid.codePointAt(1)!.toString(16).toUpperCase()}`
    assert.throws(() => spawnerTitle(invalid, 'ZAVOD'), { name: 'RangeError', message: /tag.*control or format/ }, label)
    assert.throws(() => pickName(['ZAVOD', invalid]), { name: 'RangeError', message: /in-use names.*control or format/ }, label)
  }
})

test('spawnerTitle and pickName reject non-string tags and entries without coercion', () => {
  for (const value of [123, null, { toString: () => 'RW' }, Symbol('RW')]) {
    const invalid = value as unknown as string
    assert.throws(() => spawnerTitle(invalid, 'ZAVOD'), { name: 'TypeError', message: /tag must be a string/ })
    assert.throws(() => pickName([invalid]), { name: 'TypeError', message: /in-use name must be a string/ })
  }
})

test('the pool cannot be reordered by a caller', () => {
  assert.throws(() => (namePool as unknown as string[]).sort())
  assert.equal(pickName([]), 'ZAVOD')
})

test('spawnerTitle joins a valid tag and name with a space', () => {
  assert.equal(spawnerTitle('RW', 'ZAVOD'), 'RW ZAVOD')
  assert.equal(spawnerTitle('rw-2', 'KAMAZ'), 'rw-2 KAMAZ')
})

test('spawnerTitle rejects empty tags and tags containing whitespace', () => {
  for (const tag of ['', ' ', '\t', ' RW', 'RW ', 'R W', 'R\tW', 'R\nW', 'R\u00a0W', 'R\u0085W']) {
    assert.throws(() => spawnerTitle(tag, 'ZAVOD'), RangeError, JSON.stringify(tag))
  }
})

test('spawnerTitle rejects names outside the pool', () => {
  for (const name of ['', 'zavod', ' ZAVOD', 'ZAVOD ', 'UNKNOWN']) {
    assert.throws(() => spawnerTitle('RW', name), RangeError, JSON.stringify(name))
  }
})

test('the package entry point exports the pool and its helpers', async () => {
  const runtime = await import('@remilia/politburo-runtime')
  assert.deepEqual(runtime.namePool, expectedNames)
  assert.equal(runtime.pickName(['ZAVOD']), 'FABRIKA')
  assert.equal(runtime.spawnerTitle('RW', 'ZAVOD'), 'RW ZAVOD')
})
