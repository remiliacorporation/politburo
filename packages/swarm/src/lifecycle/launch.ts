import { sameBinding, type Binding, type Journal, type JournalFailure, type JournalRecord } from './journal.ts'
export { launchKey, openJournal } from './journal.ts'
export type { Binding, Journal, JournalFailure, JournalRecord } from './journal.ts'

type Probe = { kind: 'one'; session: string } | { kind: 'absent' } | { kind: 'unknown' }
// The cloud adapter is not shipped. Probe validates the binding in the key's repo/account;
// only an authoritative negative is absent. Send uses the exact key as the session title and rejects on timeout.
export type Provider = {
  send(request: { key: string; binding: Binding }): Promise<{ session: string }>
  probe(key: string): Promise<Probe>
}
export type Control = {
  /** A numeric epoch means admission is open; report unknown when paused or unreadable. */
  epoch(): Promise<number | 'unknown'>
  /** Validate the pinned ledger binding against the current claim; required for recovered sends. */
  matches?(key: string, binding: Binding): Promise<boolean>
}
type Reason = Exclude<NonNullable<JournalRecord['reason']>, 'attention_reserved'>
// No board attention writer is shipped.
export type Attention = { raise(input: { key: string; reason: Reason }): Promise<void> }
export type HookStep = JournalRecord['state'] | 'load' | 'probe' | 'epoch_before_sent' | 'epoch_before_send'
  | 'binding' | 'send' | 'attention_reserved' | 'attention'
type Options = {
  journal: Journal; provider: Provider; control: Control; attention?: Attention
  now?: () => number; hook?: (step: HookStep) => void | Promise<void>
}
export type LaunchResult = JournalFailure | {
  key: string
  status: 'launched' | 'adopted' | 'reattached' | 'confirmed' | 'abandoned' | 'uncertain' | 'refused_paused' | 'refused_binding'
  session?: string; reason?: Reason; attention?: 'failed'
}
type ActionResult = Exclude<LaunchResult, JournalFailure>

type Replay = Extract<Awaited<ReturnType<Journal['load']>>, { ok: true }>
const sessionId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

function actions(options: Options, replay: Replay, key: string, binding: Binding) {
  const { journal, provider, control, attention, now = Date.now, hook } = options
  const step = async (name: HookStep) => { await hook?.(name) }

  async function record(state: JournalRecord['state'], extra: Pick<JournalRecord, 'session' | 'reason'> = {}) {
    await step(extra.reason === 'attention_reserved' ? 'attention_reserved' : state)
    const row = { key, binding, state, seq: replay.seq + 1, at: now(), ...extra }
    await journal.append(row)
    replay.seq = row.seq
    replay.latest.set(key, row)
  }

  async function flag(result: ActionResult, reason: Reason): Promise<ActionResult> {
    if (!attention || replay.attention.has(key)) return result
    const row = replay.latest.get(key)!
    // Reserve before calling: a crash may lose the alert, but must not raise it twice.
    await record(row.state, { session: row.session, reason: 'attention_reserved' })
    replay.attention.add(key)
    await step('attention')
    try { await attention.raise({ key, reason }) } catch { return { ...result, attention: 'failed' } }
    return result
  }

  async function uncertain(reason: Reason): Promise<ActionResult> {
    if (replay.latest.get(key)?.state !== 'uncertain') await record('uncertain', { reason })
    return flag({ key, status: 'uncertain', reason }, reason)
  }

  async function epochMatches() {
    try { return await control.epoch() === binding.epoch } catch { return false }
  }

  async function bindingMatches(recovered: boolean) {
    if (!control.matches) return !recovered
    try { return await control.matches(key, { ...binding }) === true } catch { return false }
  }

  async function abandon(reason: 'board_paused' | 'binding_mismatch', recovered: boolean): Promise<ActionResult> {
    await record('abandoned', { reason })
    return { key, status: !recovered && reason === 'board_paused' ? 'refused_paused' : 'abandoned', reason }
  }

  async function firstSend(recovered: boolean): Promise<ActionResult> {
    if (control.matches || recovered) {
      await step('binding')
      if (!await bindingMatches(recovered)) return abandon('binding_mismatch', recovered)
    }
    await step('epoch_before_sent')
    if (!await epochMatches()) return abandon('board_paused', recovered)
    await record('sent')
    await step('epoch_before_send')
    if (hook) await hook('send')
    if (!await bindingMatches(recovered)) return abandon('binding_mismatch', recovered)
    if (!await epochMatches()) return abandon('board_paused', recovered)
    let session: string
    try { ({ session } = await provider.send({ key, binding: { ...binding } })) } catch { return uncertain('send_ambiguous') }
    if (!sessionId(session)) return uncertain('send_ambiguous')
    await record('confirmed', { session })
    return { key, status: 'launched', session }
  }

  async function reconcile(row: JournalRecord): Promise<ActionResult> {
    await step('probe')
    let probe: Probe
    try { probe = await provider.probe(key) } catch { probe = { kind: 'unknown' } }
    if (probe?.kind === 'one' && !sessionId(probe.session)) probe = { kind: 'unknown' }
    if (row.state === 'abandoned') {
      const reason = probe?.kind === 'one' ? 'stray_session' : probe?.kind === 'absent' ? undefined : 'probe_unknown'
      const result = { key, status: 'abandoned', reason } as const
      return reason === 'stray_session' ? flag(result, reason) : result
    }
    if (row.state === 'confirmed') {
      if (probe?.kind === 'one' && probe.session === row.session) return { key, status: 'reattached', session: row.session }
      const reason = probe?.kind === 'absent' ? 'missing_session' : 'probe_unknown'
      const result = { key, status: 'confirmed', session: row.session, reason } as const
      return reason === 'missing_session' ? flag(result, reason) : result
    }
    if (probe?.kind === 'one') {
      await record('confirmed', { session: probe.session })
      return { key, status: 'adopted', session: probe.session }
    }
    if (probe?.kind === 'absent' && row.state === 'intended') return firstSend(true)
    return uncertain(probe?.kind === 'absent' ? 'probe_absent' : 'probe_unknown')
  }

  return { record, firstSend, reconcile }
}

/** Dispatch a freshly admitted attempt. Existing intents must reconcile before they can send. */
export async function launch(options: Options & { key: string; binding: Binding }): Promise<LaunchResult> {
  const { journal, key, hook } = options
  const binding = { ...options.binding }
  return journal.exclusive(async () => {
    await hook?.('load')
    const replay = await journal.load()
    if (!replay.ok) return replay
    const row = replay.latest.get(key)
    const action = actions(options, replay, key, binding)
    if (!row) {
      await action.record('intended')
      return action.firstSend(false)
    }
    if (!sameBinding(row.binding, binding)) return { key, status: 'refused_binding', reason: 'binding_mismatch' }
    if (row.state === 'intended') return action.reconcile(row)
    if (row.state === 'sent') return { key, status: 'uncertain' }
    return { key, status: row.state, session: row.session }
  })
}

/** Reconcile identities, not authority to admit a session's results. */
export async function recover(options: Options): Promise<ActionResult[] | JournalFailure> {
  const { journal, hook } = options
  return journal.exclusive(async () => {
    await hook?.('load')
    const replay = await journal.load()
    if (!replay.ok) return replay
    const results: ActionResult[] = []
    for (const row of replay.latest.values()) {
      results.push(await actions(options, replay, row.key, row.binding).reconcile(row))
    }
    return results
  })
}
