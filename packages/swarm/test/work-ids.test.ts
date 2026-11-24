import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allocateWorkId, formatWorkId, parseWorkId, sourceBadge } from '../src/index.ts'

test('work IDs do not retain input case or surrounding whitespace', () => {
  assert.deepEqual(parseWorkId('  PlB-482\n'), { tag: 'plb', number: 482 })
  assert.equal(formatWorkId('PLB', 482), 'plb-482')
})

test('the ID parser rejects malformed or unsafe numbers', () => {
  for (const id of ['plb-0', 'plb-01', 'plb-1.2', 'plb-1\n2', 'p1b-1', 'plb-9007199254740992']) {
    assert.equal(parseWorkId(id), null, id)
  }
  assert.equal(parseWorkId('plb-9007199254740991')?.number, Number.MAX_SAFE_INTEGER)
})

test('allocation advances the persisted mark without allowing unknown tags or unsafe sequences', () => {
  const tags = ['plb']
  const previous = allocateWorkId(tags, 'PLB', 481)
  assert.deepEqual(previous, { id: 'plb-482', highWater: 482 })
  assert.deepEqual(allocateWorkId(tags, 'plb', previous.highWater), { id: 'plb-483', highWater: 483 })
  assert.throws(() => allocateWorkId(tags, 'xyz', 0), RangeError)
  for (const mark of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => allocateWorkId(tags, 'plb', mark), RangeError)
  }
})

test('source badges do not double GitHub hashes, rewrite bead IDs, or accept unknown sources', () => {
  assert.equal(sourceBadge({ source: 'github', ref: '812' }), 'GH#812')
  assert.equal(sourceBadge({ source: 'github', ref: '#812' }), 'GH#812')
  assert.equal(sourceBadge({ source: 'linear', ref: 'ENG-123' }), 'LIN ENG-123')
  assert.equal(sourceBadge({ source: 'beads', ref: 'rw-4u5' }), 'bd rw-4u5')
  assert.throws(() => sourceBadge({ source: 'native' as 'github', ref: '812' }))
})
