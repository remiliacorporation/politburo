import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs, { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { block, board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { parse, stringify } from 'yaml'
import {
  createBridge, createInbox, createRelay, MAIL_SCHEMA, registerMailSchema, sendMail, type MailMessage,
} from '../src/mail/index.ts'

const tag = 'plb'
const inbox = 'inbox'
const now = () => new Date('2026-11-21T00:00:00Z')

function mail(id: string): MailMessage {
  return {
    id, class: 'sec.push', urgency: 'p2', from: 'attempt-120', ref: 'plb-482',
    summary: 'Review ready: three findings', body: 'First finding.\n\nSee `src/mail`.\n',
    at: '2026-11-20T21:14:00Z', expires: '2026-11-22T00:00:00Z', dispatch: 'execution-17',
  }
}

function markdown(message: Record<string, unknown>) {
  return `${message.summary}\n\`\`\`yaml\n${stringify(message)}\`\`\`\n`
}

function checkFile(text: string, expected: MailMessage) {
  const header = /^([^\n]+)\n```yaml\n([\s\S]+)\n```\n$/.exec(text)
  assert.ok(header, 'expected a complete Markdown header and YAML block')
  assert.equal(header[1], expected.summary)
  const { origin: _origin, ...message } = parse(header[2]!)
  assert.deepEqual(message, expected)
  return message
}

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-mail-bridge-'))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({ backend })
  await registerMailSchema(team)
  const options = { board: team, dir, tag, inbox, outbox: 'outbox', scope: 'core', now }
  const incoming = join(dir, tag, 'in')
  const outgoing = join(dir, tag, 'out')
  await mkdir(outgoing, { recursive: true })
  return {
    dir, team, options, incoming, outgoing, bridge: createBridge(options),
    admit: (channel = inbox) => createInbox({ board: team, channel, now }).admit(),
    send: (message: MailMessage, channel = inbox) => sendMail(team, channel, message, { scope: 'core' }),
    roots: async (channel = inbox) => (await team.channel(channel).messages({ after: '0' }))
      .messages.filter(({ re }) => re === null),
    write: (file: string, message: Record<string, unknown>) => writeFile(join(outgoing, file), markdown(message)),
  }
}

test('the file-board-file gate does not lose fields or drift in canonical refs', async (t) => {
  const { options, incoming, write, bridge, roots, send, admit } = await setup(t)
  const delivery = 'recipient/inbox'
  const exporter = createBridge({ ...options, inbox: delivery })
  const stringRef = mail('string-ref')
  const mappingRef = { ...mail('mapping-ref'), ref: '{"kind":"issue","work":{"number":482,"repo":"acme/web"}}' }
  await write('string-ref.md', { ...stringRef, at: '2026-11-20T21:14Z', expires: '2026-11-22T00:00Z' })
  await write('mapping-ref.md', { ...mappingRef, ref: { work: { repo: 'acme/web', number: 482 }, kind: 'issue' } })
  assert.equal((await bridge.importOnce()).imported, 2)

  // Deliver the landed payloads as board-originated mail in a different inbox.
  // Exporting from the source inbox would be an echo, not a delivery.
  const imported = await roots()
  assert.equal(imported.length, 2)
  for (const expected of [stringRef, mappingRef]) {
    const landed = imported.find(({ blocks }) => blocks[0]?.data.id === expected.id)
    assert.ok(landed, expected.id)
    assert.equal(landed.blocks.length, 1)
    assert.deepEqual(landed.blocks[0]?.data, expected)
    await send(landed.blocks[0]!.data as MailMessage, delivery)
  }
  await admit(delivery)
  assert.equal((await exporter.exportOnce()).exported, 2)
  checkFile(await readFile(join(incoming, 'string-ref.md'), 'utf8'), stringRef)
  const canonical = checkFile(await readFile(join(incoming, 'mapping-ref.md'), 'utf8'), mappingRef)

  // A fresh file authored with the exported fields must retain the canonical ref
  // on another import and delivery, not gain another layer of JSON quoting.
  await write('next.md', { ...canonical, id: 'next' })
  assert.deepEqual((await bridge.importOnce()).rejected, [])
  const next = (await roots()).find(({ blocks }) => blocks[0]?.data.id === 'next')
  const expected = { ...mappingRef, id: 'next' }
  assert.ok(next)
  assert.deepEqual(next.blocks[0]?.data, expected)
  const nextDelivery = 'next-recipient/inbox'
  await send(next.blocks[0]!.data as MailMessage, nextDelivery)
  await admit(nextDelivery)
  assert.equal((await createBridge({ ...options, inbox: nextDelivery }).exportOnce()).exported, 1)
  checkFile(await readFile(join(incoming, 'next.md'), 'utf8'), expected)
})

test('a file-originated message does not echo back to files on repeated scans', async (t) => {
  const { write, bridge, admit, roots, incoming, outgoing } = await setup(t)
  await write('from-file.md', mail('from-file'))
  for (let cycle = 0; cycle < 2; cycle++) {
    assert.deepEqual((await bridge.importOnce()).rejected, [])
    await admit()
    assert.equal((await bridge.exportOnce()).exported, 0)
  }
  assert.equal((await roots()).length, 1)
  assert.deepEqual(await readdir(incoming), [])
  assert.deepEqual(await readdir(outgoing), ['from-file.md'])
})

test('file-originated mail relayed to another board does not echo after a retry', async (t) => {
  const source = await setup(t)
  const dest = await setup(t)
  const message = { ...mail('routed-file'), to: 'dest/inbox' }
  await source.write('routed-file.md', message)
  assert.equal((await source.bridge.importOnce()).imported, 1)
  const options = { source: { name: 'source', board: source.team, outbox: source.options.outbox }, now }
  const interrupted = createRelay({ ...options, boards: { dest: {
    ...dest.team,
    async post(...args) {
      await dest.team.post(...args)
      throw new Error('destination response lost')
    },
  } } })
  assert.deepEqual((await interrupted.deliverOnce()).down, ['dest'])

  // Check the first landed post, before any retry could repair its labels.
  await dest.admit()
  assert.deepEqual((await dest.roots()).map((root) => root.blocks[0]?.data), [message])
  assert.equal((await dest.bridge.exportOnce()).exported, 0)
  assert.deepEqual(await readdir(dest.incoming), [])
  const relay = createRelay({ ...options, boards: { dest: dest.team } })
  assert.equal((await relay.deliverOnce()).delivered, 1)
  assert.equal((await dest.roots()).length, 1)
})

test('an exported board file does not get re-imported from out', async (t) => {
  const { send, admit, roots, bridge, incoming, outgoing } = await setup(t)
  const original = await send(mail('from-board'))
  await admit()
  assert.equal((await bridge.exportOnce()).exported, 1)
  // Hand the exported bytes back to the scanner, rather than relying on the
  // separation of in/ and out/ to prevent a loop.
  await copyFile(join(incoming, 'from-board.md'), join(outgoing, 'from-board.md'))
  const report = await bridge.importOnce()
  assert.deepEqual((await roots()).map(({ id }) => id), [original.id])
  assert.deepEqual(report, { imported: 0, skipped: 1, rejected: [] })
  assert.equal((await bridge.exportOnce()).exported, 0)
  assert.deepEqual(await readdir(incoming), ['from-board.md'])
})

test('a fresh exporter does not recreate a consumed file for handled mail', async (t) => {
  const { options, dir, send, admit, bridge, incoming } = await setup(t)
  const message = mail('consumed')
  const root = await send(message)
  await admit()
  assert.equal((await bridge.exportOnce()).exported, 1)
  assert.equal(await createInbox({ board: options.board, channel: inbox, now }).take(root.id), true)
  await rm(join(incoming, 'consumed.md'))

  assert.equal((await createBridge(options).exportOnce()).exported, 0)
  assert.deepEqual(await readdir(incoming), [])
  assert.deepEqual(JSON.parse(await readFile(join(dir, tag, '.bridge-exported.json'), 'utf8')), [message.id])
})

test('a failed record rename leaves the file for the next export to reconcile', async (t) => {
  const { options, dir, send, admit, bridge, incoming } = await setup(t)
  const message = mail('unrecorded')
  const target = join(incoming, 'unrecorded.md')
  const record = join(dir, tag, '.bridge-exported.json')
  await send(message)
  await admit()
  const interrupted = new Error('record rename failed')
  const rename = fs.rename
  const renamer = t.mock.method(fs, 'rename', async (from: string, to: string) => {
    if (to === record) throw interrupted
    await rename(from, to)
  })
  try {
    syncBuiltinESMExports()
    await assert.rejects(bridge.exportOnce(), (error) => error === interrupted)
    checkFile(await readFile(target, 'utf8'), message)
    assert.deepEqual((await readdir(join(dir, tag))).sort(), ['in', 'out'])
  } finally {
    renamer.mock.restore()
    syncBuiltinESMExports()
  }
  assert.deepEqual(await createBridge(options).exportOnce(), { exported: 0, skipped: 1, conflicts: [], rejected: [] })
  await rm(target)
  assert.equal((await createBridge(options).exportOnce()).exported, 0)
  assert.deepEqual(await readdir(incoming), [])
})

test('export creates private files and directories regardless of umask', async (t) => {
  const { options, dir, send, admit } = await setup(t)
  await send(mail('private'))
  await admit()
  for (const mask of [0, 0o777]) {
    const parent = join(dir, `mask-${mask}`)
    const base = join(parent, 'mail')
    const mailbox = join(base, tag)
    const incoming = join(mailbox, 'in')
    const previous = process.umask(mask)
    try {
      assert.equal((await createBridge({ ...options, dir: base }).exportOnce()).exported, 1)
    } finally {
      process.umask(previous)
    }
    for (const path of [parent, base, mailbox, incoming]) {
      assert.equal((await stat(path)).mode & 0o777, 0o700, path)
    }
    for (const path of [join(incoming, 'private.md'), join(mailbox, '.bridge-exported.json')]) {
      assert.equal((await stat(path)).mode & 0o777, 0o600, path)
    }
  }
})

test('a lost import response causes neither a duplicate root nor a file echo', async (t) => {
  const { team, options, write, bridge, roots, admit, incoming } = await setup(t)
  const message = mail('interrupted')
  await write('interrupted.md', message)
  const lost = new Error('response lost after post landed')
  const interrupted = createBridge({ ...options, board: {
    ...team,
    async post(...args) {
      await team.post(...args)
      throw lost
    },
  } })
  await assert.rejects(interrupted.importOnce(), (error) => error === lost)
  const before = await roots()
  assert.equal(before.length, 1)
  // The exporter can run before the importer restarts.
  await admit()
  await bridge.exportOnce()
  assert.deepEqual(await readdir(incoming), [])
  assert.deepEqual(await bridge.importOnce(), { imported: 1, skipped: 0, rejected: [] })
  const after = await roots()
  assert.deepEqual(after.map(({ id }) => id), before.map(({ id }) => id))
  assert.deepEqual(after[0]?.blocks[0]?.data, message)
})

test('a failed export never exposes a partial Markdown file or leaves debris', async (t) => {
  const { send, admit, bridge, incoming } = await setup(t)
  const complete = mail('complete')
  await send(complete)
  await admit()
  assert.equal((await bridge.exportOnce()).exported, 1)
  await send({ ...mail('interrupted'), ref: 'plb-483' })
  await admit()

  const diskFull = new Error('disk full during write')
  const realWrite = fs.writeFile
  const writer = t.mock.method(fs, 'writeFile', async (...[path, , options]: Parameters<typeof realWrite>) => {
    await realWrite(path, 'Incomplete header\n```yaml\nid: inter', options)
    assert.deepEqual((await readdir(incoming)).filter((file) => file.endsWith('.md')), ['complete.md'])
    throw diskFull
  })
  t.after(() => {
    writer.mock.restore()
    syncBuiltinESMExports()
  })
  syncBuiltinESMExports()
  await assert.rejects(bridge.exportOnce(), (error) => error === diskFull)
  assert.deepEqual(await readdir(incoming), ['complete.md'])
  checkFile(await readFile(join(incoming, 'complete.md'), 'utf8'), complete)
})

test('export reports a conflict instead of overwriting different file bytes', async (t) => {
  const { send, admit, bridge, incoming } = await setup(t)
  const message = mail('conflict')
  await send(message)
  await admit()
  await mkdir(incoming)
  const target = join(incoming, 'conflict.md')
  const edited = Buffer.from(markdown({ ...message, body: 'Edited locally.\n' }))
  await writeFile(target, edited)
  const report = await bridge.exportOnce()
  assert.ok(edited.equals(await readFile(target)), 'existing file bytes changed')
  assert.deepEqual(report.conflicts, ['conflict.md'])
  assert.equal(report.exported, 0)
})

test('unsafe mail IDs are rejected instead of becoming export paths', async (t) => {
  const { dir, team, bridge } = await setup(t)
  // Keep every possible write in the sandbox, even with the filename guard broken.
  const ids = ['../x', join(dir, 'absolute'), 'sub/nested', '.hidden', 'nul\0id']
  for (const id of ids) {
    // A handled root can exist without a usable sender ID in its post key.
    await team.post(inbox, { text: block(MAIL_SCHEMA, mail(id)), labels: { 'swarm.state': 'handled' } })
  }
  const report = await bridge.exportOnce()
  assert.deepEqual((await readdir(dir, { recursive: true })).sort(), [tag, `${tag}/in`, `${tag}/out`])
  assert.equal(report.exported, 0)
  assert.deepEqual(report.rejected.sort((a, b) => a.file.localeCompare(b.file)),
    ids.sort((a, b) => a.localeCompare(b)).map((file) => ({ file, problems: ['unsafe_id'] })))
})

test('invalid urgency, forbidden expiry and bad timestamps are reported without consuming files', async (t) => {
  const { write, bridge, outgoing, roots } = await setup(t)
  const cases = [
    { file: 'bad-at.md', fields: { at: 'not an instant' }, reason: 'invalid_at' },
    { file: 'bad-expiry.md', fields: { urgency: 'p1' }, reason: 'expiry_not_allowed' },
    { file: 'bad-urgency.md', fields: { urgency: 'urgent' }, reason: 'invalid_urgency' },
  ]
  const originals = new Map<string, Buffer>()
  for (const { file, fields } of cases) {
    await write(file, { ...mail(file), ...fields })
    originals.set(file, await readFile(join(outgoing, file)))
  }
  assert.deepEqual(await bridge.importOnce(), {
    imported: 0, skipped: 0, rejected: cases.map(({ file, reason }) => ({ file, problems: [reason] })),
  })
  assert.deepEqual(await roots(), [])
  for (const [file, bytes] of originals) assert.deepEqual(await readFile(join(outgoing, file)), bytes)
})

test('bridge import misuse exits 2 and does not write a report to stdout', async (t) => {
  const { dir } = await setup(t)
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
  const flags = ['--dir', dir, '--scope', 'core', '--inbox', inbox]
  for (const [extra, error] of [
    [[], /^error: expected --dir, --tag, --scope and --inbox\b/],
    [['--tag', tag, '--unknown'], /^error: invalid bridge flags\n/],
    [['--tag', '../plb'], /^error: invalid tag\n/],
  ] as const) {
    const result = spawnSync(process.execPath, [cli, 'mail', 'bridge', 'import', ...flags, ...extra], {
      cwd: dir, env: {}, encoding: 'utf8',
    })
    if (result.error) throw result.error
    assert.equal(result.status, 2, result.stderr)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, error)
  }
})
