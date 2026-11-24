#!/usr/bin/env node
// Owner decisions on a board, with what a board already has: a decision is a thread root in one
// channel, its state is a label, and an answer applies once because the label changes only if it
// is still `open`. `watch` blocks on the board's feed, so nothing polls and no model runs.
//
// Every board call goes through the `vb` CLI, as an agent's would.
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

const channel = process.env.DECISIONS_CHANNEL ?? 'swarm/core/decisions'
const stateDir = process.env.DECISIONS_STATE_DIR ?? join(homedir(), '.local', 'state', 'board-decisions')
const answersDir = process.env.DECISIONS_ANSWERS_DIR
/** The `vb` to run: `DECISIONS_VB` as a path to its `cli.mjs`, or this checkout's build. */
const cli = process.env.DECISIONS_VB ?? join(here, '..', '..', 'packages', 'board', 'dist', 'cli.mjs')

class Refused extends Error {}

/** Runs `vb` and answers its stdout. A refusal carries what `vb` said on stderr. */
async function vb(...args) {
  try {
    const { stdout } = await run(process.execPath, [cli, ...args], { maxBuffer: 16 * 1024 * 1024 })
    return stdout
  } catch (error) {
    if (typeof error.code === 'number') throw Object.assign(new Refused((error.stderr || error.stdout || '').trim()), { stdout: error.stdout ?? '' })
    throw error
  }
}

const firstLine = (text) => text.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''

/** `3h 12m`, `14m`, `2d 4h`: how long a decision has waited. */
function age(iso, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`
}

async function openDecisions() {
  const { threads, cursor } = JSON.parse(await vb('read', channel, '--label', 'decision.state=open', '--json'))
  return { decisions: threads.map((thread) => thread.message).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), cursor }
}

/** Posts a decision. The key makes a repeated ask post once. Prints the decision's ID. */
async function ask(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { key: { type: 'string' }, summary: { type: 'string' }, file: { type: 'string' }, needs: { type: 'string' }, urgency: { type: 'string' }, from: { type: 'string' }, due: { type: 'string' }, asked: { type: 'string' }, as: { type: 'string' } },
  })
  if (!values.key || !values.summary || !values.needs) throw new Refused('usage: decisions ask --key <id> --summary "<one line>" --needs <who> [--file <detail>] [--urgency p0..p3] [--from <who>] [--due <ISO time>] [--asked <ISO time, when it was first asked elsewhere>] [--as <profile>]')
  const detail = values.file ? (await readFile(values.file, 'utf8')).trim() : ''
  const text = detail ? `${values.summary.trim()}\n\n${detail}` : values.summary.trim()
  const labels = { 'decision.state': 'open', 'decision.key': values.key, 'decision.needs': values.needs, 'decision.urgency': values.urgency, 'decision.from': values.from, 'decision.due': values.due, 'decision.asked': values.asked }
  const flags = Object.entries(labels).flatMap(([key, value]) => (value ? ['--label', `${key}=${value}`] : []))
  const id = await vb('post', channel, text, ...flags, '--idempotency-key', `decision:${values.key}`, '--no-sync', ...(values.as ? ['--as', values.as] : []))
  process.stdout.write(id.trim())
}

/** Lists what waits, oldest first. */
async function open(argv) {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' } } })
  const { decisions } = await openDecisions()
  if (values.json) return void console.log(JSON.stringify({ decisions }))
  if (decisions.length === 0) return void console.log('no open decisions')
  const width = Math.max(...decisions.map((decision) => `#${decision.id}`.length))
  for (const decision of decisions) {
    const needs = decision.labels['decision.needs'] ?? ''
    console.log(`${`#${decision.id}`.padEnd(width)}  open ${age(decision.labels['decision.asked'] ?? decision.createdAt)}  ${needs}  ${firstLine(decision.text)}`)
  }
}

/** Answers a decision once: the state changes only while it is still open, then the answer is its reply. */
async function answer(argv) {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true })
  const [id, ...words] = positionals
  const text = words.join(' ').trim()
  if (!id || !text) throw new Refused('usage: decisions answer <id> "<the option you choose, and anything to add>"')
  try {
    await vb('label', id, 'decision.state=answered', '--if', 'decision.state=open')
  } catch (error) {
    if (error instanceof Refused) throw new Refused(`#${id} is not an open decision: it was answered already, or it is not one.\n${error.message}`)
    throw error
  }
  await vb('reply', id, text, '--label', 'decision.answer=yes', '--idempotency-key', `decision-answer:${id}`, '--no-sync')
  console.log(`answered #${id}`)
}

/** Runs the notifier for a decision that needs someone. What it prints or returns never stops the watch. */
async function notify(decision) {
  const title = firstLine(decision.text)
  const env = { ...process.env, DECISION_ID: decision.id, DECISION_TITLE: title, DECISION_NEEDS: decision.labels['decision.needs'] ?? '', DECISION_URGENCY: decision.labels['decision.urgency'] ?? '' }
  try {
    if (process.env.DECISIONS_NOTIFY) await run('/bin/sh', ['-c', process.env.DECISIONS_NOTIFY], { env })
    else if (process.platform === 'darwin')
      await run('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv) sound name "Glass"', '-e', 'end run', '--', title, `Decision needed (#${decision.id})`])
    else console.log(`decision needed  #${decision.id}  ${title}`)
  } catch (error) {
    console.error(`could not notify for #${decision.id}: ${error.message}`)
  }
}

/** Writes what a decision was answered with where other tools read it, when a directory is set. */
async function recordAnswer(id) {
  if (!answersDir) return
  const { message, replies } = await thread(id)
  const last = replies.findLast((reply) => reply.labels['decision.answer'] !== undefined)
  if (!last) return
  const key = message.labels['decision.key'] ?? id
  const record = { key, id, summary: firstLine(message.text), answer: last?.text ?? '', answeredBy: last?.by.actor ?? null, answeredAt: last?.createdAt ?? null, askedAt: message.labels['decision.asked'] ?? message.createdAt }
  await mkdir(answersDir, { recursive: true })
  const file = join(answersDir, `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  await writeFile(`${file}.partial`, `${JSON.stringify(record, null, 2)}\n`)
  await rename(`${file}.partial`, file)
}

async function thread(id) {
  const read = JSON.parse(await vb('read', id, '--json'))
  const messages = read.messages ?? [read.message, ...(read.replies ?? [])]
  const [message, ...replies] = messages
  return { message, replies }
}

/** Follows the channel: notifies for each new decision, and records each answer. Runs until stopped. */
async function watch(argv) {
  const { values } = parseArgs({ args: argv, options: { once: { type: 'boolean' }, timeout: { type: 'string' } } })
  await mkdir(stateDir, { recursive: true })
  const cursorFile = join(stateDir, 'cursor')
  let cursor = (await readFile(cursorFile, 'utf8').catch(() => '')).trim()
  if (!cursor) {
    // First run: everything open now needs someone, and the feed is followed from here.
    const { decisions, cursor: head } = await openDecisions()
    for (const decision of decisions) await notify(decision)
    cursor = head ?? '0'
    await writeFile(cursorFile, `${cursor}\n`)
  }
  for (;;) {
    let event
    try {
      ;({ event } = JSON.parse(await vb('wait', channel, '--after', cursor, '--timeout', values.timeout ?? '25m', '--json')))
    } catch (error) {
      if (!(error instanceof Refused)) throw error
      const said = (() => { try { return JSON.parse(error.message || error.stdout) } catch { return null } })()
      if (said?.reason === 'timeout') {
        if (values.once) return
        continue
      }
      throw error
    }
    const { message } = event
    if (event.type === 'message.posted' && message.re === null && message.labels['decision.state'] === 'open') await notify(message)
    // The answer is the reply that follows the state change, so the record waits for it.
    if (event.type === 'message.posted' && message.re !== null && message.labels['decision.answer'] !== undefined) await recordAnswer(message.re)
    cursor = event.cursor
    await writeFile(cursorFile, `${cursor}\n`)
  }
}

const commands = { ask, open, answer, watch }
const [name, ...rest] = process.argv.slice(2)
const command = commands[name]
if (!command) {
  console.error('usage: decisions (ask | open | answer | watch) ...')
  process.exit(2)
}
try {
  await command(rest)
} catch (error) {
  if (!(error instanceof Refused)) throw error
  console.error(`error: ${error.message}`)
  process.exit(1)
}
