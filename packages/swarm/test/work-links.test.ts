import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addLink, type Link } from '../src/index.ts'

const issue: Link = { kind: 'issue', source: 'github', scope: 'acme/web', ref: '812', basis: 'explicit' }

test('same-ref links must not collapse across scopes or duplicate within one scope', () => {
  const otherRepo = { ...issue, scope: 'acme/api' }
  const linked = addLink([issue], otherRepo)
  assert.deepEqual(linked, [issue, otherRepo])
  assert.deepEqual(addLink(linked, { ...otherRepo, basis: 'stable_ref' }), linked)

  for (const scope of [undefined, '', ' ', 'x'.repeat(513)]) {
    assert.throws(() => addLink([], { ...issue, scope: scope as string }), TypeError)
  }
})

test('adding links does not mutate the input or merge distinct stable identities', () => {
  const before = Object.freeze([issue])
  assert.deepEqual(addLink(before, { ...issue, basis: 'stable_ref' }), [issue])
  for (const distinct of [{ ...issue, kind: 'pull_request' } as const, { ...issue, source: 'linear' }, { ...issue, ref: '813' }]) {
    assert.deepEqual(addLink(before, distinct), [issue, distinct])
  }
})

test('a new link is recorded with either explicit or stable-reference provenance', () => {
  const stable: Link = { ...issue, basis: 'stable_ref' }
  assert.deepEqual(addLink([], issue), [issue])
  assert.deepEqual(addLink([], stable), [stable])
})

test('missing and title-only link provenance and invalid fields are rejected even on duplicates', () => {
  const noBasis = { kind: issue.kind, source: issue.source, scope: issue.scope, ref: issue.ref }
  for (const link of [
    noBasis as Link,
    { ...issue, basis: 'similar_title' as Link['basis'] },
    { ...issue, kind: '' as Link['kind'] },
    { ...issue, source: ' ' },
    { ...issue, ref: 'x'.repeat(513) },
  ]) {
    assert.throws(() => addLink([issue], link), TypeError)
  }
})
