import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

const tags = ['abc', 'def', 'xyz']

function poster(t: TestContext, failTag = '') {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-poster-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const script = join(dir, 'fake poster.cjs'), log = join(dir, 'posted.jsonl'), registry = join(dir, 'tags.json')
  writeFileSync(registry, JSON.stringify({ tags: tags.map(tag => ({ tag, project: tag })) }))
  writeFileSync(log, '')
  writeFileSync(script, `
    const { appendFileSync, readFileSync } = require('node:fs')
    const [log, failTag, tag, ...extra] = process.argv.slice(2)
    if (!tag || extra.length) process.exit(2)
    const message = JSON.parse(readFileSync(0, 'utf8'))
    appendFileSync(log, JSON.stringify({ tag, message }) + '\\n')
    if (tag === failTag) process.exitCode = 7
  `)
  const command = JSON.stringify([process.execPath, script, log, failTag])
  function send(overrides: Record<string, string | boolean | undefined> = {}) {
    const options = { to: 'all', class: 'policy', urgency: 'p0', ref: 'task-42', summary: 'review requested',
      body: 'first line\nsecond line', id: 'notice', tags: registry, 'post-cmd': command, ...overrides }
    const flags = Object.entries(options).flatMap(([key, value]) =>
      typeof value === 'string' ? [`--${key}`, value] : value === true ? [`--${key}`] : [])
    const result = spawnSync(process.execPath, ['src/cli.ts', 'mail', 'send', ...flags], {
      cwd: new URL('../', import.meta.url), encoding: 'utf8', env: {}, timeout: 5000,
    })
    if (result.error) throw result.error
    return result
  }
  function received(): { tag: string; message: { id: string; at: string; body: string } }[] {
    return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  }
  return { dir, send, received, clear: () => writeFileSync(log, '') }
}

function refusal(result: ReturnType<ReturnType<typeof poster>['send']>, code: number, error: RegExp) {
  assert.equal(result.status, code, result.stderr || result.stdout)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, error)
}

test('mail send --to all does not miss or double-post any registry tag or drop the id suffix', (t) => {
  const f = poster(t)
  const result = f.send()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.deepEqual(f.received().map(({ tag, message }) => [tag, message.id]).sort(),
    tags.map(tag => [tag, `notice.${tag}`]))
  assert.deepEqual(result.stdout.trim().split('\n').sort(), tags.map(tag => `${tag}  sent`))
})

test('mail send does not suppress a retry or change its per-tag ids with the same --id', (t) => {
  const f = poster(t)
  const send = () => {
    const result = f.send({ id: 'retry-42' })
    assert.equal(result.status, 0, result.stderr)
    return f.received().map(({ tag, message }) => [tag, message.id]).sort()
  }
  const first = send()
  assert.deepEqual(first.map(([tag]) => tag), tags)
  f.clear()
  assert.deepEqual(send(), first)
})

test('mail send does not stop at the first failed tag or exit successfully after a failure', (t) => {
  const f = poster(t, tags[0])
  const result = f.send()
  assert.deepEqual(f.received().map(({ tag }) => tag).sort(), tags)
  assert.equal(result.status, 1, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /^abc +failed .+$/m)
  assert.match(result.stdout, /^def +sent$/m)
  assert.match(result.stdout, /^xyz +sent$/m)
})

test('mail send fails a p0 when the poster closes stdin and exits zero', (t) => {
  const f = poster(t)
  const script = join(f.dir, 'close-stdin.cjs'), bodyFile = join(f.dir, 'large-body.txt')
  writeFileSync(script, "require('node:fs').closeSync(0); process.exit(0)")
  writeFileSync(bodyFile, 'x'.repeat(1024 * 1024))
  const result = f.send({ to: 'abc', body: undefined, 'body-file': bodyFile,
    'post-cmd': JSON.stringify([process.execPath, script]) })
  assert.equal(result.status, 1, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /^abc +failed .+\n$/)
})

for (const urgency of ['p0', 'p1']) {
  test(`mail send does not post ${urgency} with expires`, (t) => {
    const f = poster(t)
    const result = f.send({ urgency, expires: '2028-01-01T00:00:00Z' })
    assert.deepEqual(f.received(), [])
    refusal(result, 2, /^error: expires:/)
  })
}

test('mail send does not post a summary longer than 120 characters', (t) => {
  const f = poster(t)
  const result = f.send({ summary: 'x'.repeat(121) })
  assert.deepEqual(f.received(), [])
  refusal(result, 2, /^error: summary:/)
})

test('mail send does not post to a tag absent from the registry', (t) => {
  const f = poster(t)
  const result = f.send({ to: 'zzz' })
  assert.deepEqual(f.received(), [])
  refusal(result, 2, /^error: to: .*registry/)
})

test('mail send does not report success without --post-cmd', (t) => {
  const f = poster(t)
  const result = f.send({ 'post-cmd': undefined })
  assert.deepEqual(f.received(), [])
  refusal(result, 1, /^error: no_poster: .*--post-cmd/)
})

test('mail send --dry-run does not post even when a poster is configured', (t) => {
  const f = poster(t)
  const result = f.send({ to: 'def', 'dry-run': true })
  assert.deepEqual(f.received(), [])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /^def +dry run +p0 policy notice\.def +review requested\n$/)
})

test('mail send rejects invalid UTF-8 in a body file without posting', (t) => {
  const f = poster(t)
  const bodyFile = join(f.dir, 'invalid-utf8.txt')
  writeFileSync(bodyFile, Buffer.from([0xc3, 0x28]))
  const result = f.send({ body: undefined, 'body-file': bodyFile })
  refusal(result, 2, /^error: body-file: not valid UTF-8\n$/)
  assert.deepEqual(f.received(), [])
})

test('mail send preserves a leading U+FEFF in a UTF-8 body file', (t) => {
  const f = poster(t)
  const bodyFile = join(f.dir, 'leading-bom.txt')
  writeFileSync(bodyFile, Buffer.from([0xef, 0xbb, 0xbf, 0x61]))
  const result = f.send({ to: 'def', body: undefined, 'body-file': bodyFile })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(f.received().map(({ message }) => message.body), ['\uFEFFa'])
})

test('CLI mail send does not lose its route or change the p0 message on the way to the poster', (t) => {
  const f = poster(t)
  const bodyFile = join(f.dir, 'body.txt'), body = 'line one\nline two\n'
  writeFileSync(bodyFile, body)
  const before = Date.now()
  const result = f.send({ to: 'def', body: undefined, 'body-file': bodyFile })
  const after = Date.now()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /^def +sent\n$/)
  const received = f.received()
  assert.equal(received.length, 1)
  const { at } = received[0]!.message
  assert.equal(new Date(at).toISOString(), at)
  assert.ok(Date.parse(at) >= before && Date.parse(at) <= after, `unexpected send time: ${at}`)
  assert.deepEqual(received, [{ tag: 'def', message: {
    id: 'notice.def', class: 'policy', urgency: 'p0', from: 'core', ref: 'task-42',
    summary: 'review requested', body, at,
  } }])
})
