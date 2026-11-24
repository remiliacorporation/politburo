import { verifyGate, type Gate } from './gate.ts'
import { CutoverError, newTag, type Clock, type Health, type Ports, type ProcessPort } from './ports.ts'
import { readState, withStateLock, writeState, type State } from './state.ts'
export { CutoverError } from './ports.ts'

export interface Context {
  ports: Ports
  stateDir: string
  clock: Clock
  budgetMs?: number
  gateMaxAgeDays?: number
  gateFile?: string
  renameTo?: string
  rollback?: boolean
  allowStale?: boolean
  log?: (line: string) => void
}

function session(tag: string, ctx: Context) {
  const { ports, clock } = ctx
  const started = clock.now(), budget = ctx.budgetMs ?? 300_000
  const elapsed = () => clock.now() - started
  const exceeded = () => new CutoverError('budget_exceeded', 'cutover time budget exceeded')
  async function call<T>(run: () => Promise<T>): Promise<T> {
    const remaining = budget - elapsed()
    if (remaining <= 0) throw exceeded()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([Promise.resolve().then(run), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(exceeded()), remaining)
      })])
      if (elapsed() >= budget) throw exceeded()
      return result
    } catch (error) {
      if (elapsed() >= budget) throw exceeded()
      throw error instanceof CutoverError ? error : new CutoverError('port_failed', 'cutover port call failed')
    } finally { clearTimeout(timer) }
  }
  const status = (p: ProcessPort) => call(() => p.status(tag))
  async function stop(p: ProcessPort) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await call(() => p.stop(tag)).catch(ignorePortFailure)
      if (await status(p).catch(ignorePortFailure) === 'stopped') return
    }
    throw new CutoverError('unconfirmed_stop', 'could not confirm process stopped')
  }
  async function start(p: ProcessPort) {
    await call(() => p.start(tag))
    if (await status(p) !== 'running') throw new CutoverError('unconfirmed_start', 'could not confirm process running')
  }
  async function sync(reason = 'bridge_not_current', headline = 'bridge files are not current') {
    const result = await call(() => ports.bridge.sync(tag)).catch(ignorePortFailure)
    if (result?.current !== true) throw new CutoverError(reason, headline)
  }
  function report(message: string, elapsedMs = elapsed()) {
    ctx.log?.(`${message}  ${elapsedMs} ms`)
    return { message, elapsedMs }
  }
  async function finish(s: State, mode: State['mode'], event: string) {
    const elapsedMs = elapsed()
    delete s.pending
    s.mode = mode
    s.history.push({ at: new Date(clock.now()).toISOString(), event, detail: `${elapsedMs} ms` })
    await writeState(ctx.stateDir, s)
    return elapsedMs
  }
  return { call, status, stop, start, sync, report, finish }
}

function ignorePortFailure(error: unknown): undefined {
  if (!(error instanceof CutoverError) || error.reason !== 'port_failed') throw error
}

function needsServiceStop(s: State, health: Health) {
  return health !== 'stopped' || s.pending !== undefined || s.mode !== 'files'
}

export async function plan(tag: string, ctx: Context) {
  const { call, status } = session(tag, ctx), { ports: p } = ctx
  const s = await readState(ctx.stateDir, tag)
  const [service, old, bridge] = await Promise.all([status(p.service), status(p.oldLoop), call(() => p.bridge.status(tag))])
  const step = (step: string, needed: boolean, why: string) => ({ step, do: needed, why })
  if (ctx.rollback) {
    const stopNeeded = needsServiceStop(s, service)
    const needed = stopNeeded || old !== 'running'
    const stop = step('service.stop', stopNeeded, `service ${service}`)
    return [step('record rollback', needed, needed ? 'rollback needed' : 'already rolled back'),
      ...(old === 'running' && service !== 'stopped' ? [stop] : [step('bridge.sync', service !== 'stopped', `service ${service}`), stop]),
      step('bridge.sync (final)', needed, bridge.current ? 'confirm files after stop' : 'files not confirmed current'),
      step('oldLoop.start', old !== 'running', `old loop ${old}`), step('record files mode', needed, `mode ${s.mode}`)]
  }
  const needed = s.mode !== 'service' || !!s.pending || service !== 'running' || old !== 'stopped'
  return [step('verify gate', true, 'apply requires approval'),
    step('bridge.sync', needed, !needed ? 'already applied' : bridge.current ? 'confirm files now' : 'files not confirmed current'),
    step('record apply', needed, `mode ${s.mode}`), step('oldLoop.stop', old !== 'stopped', `old loop ${old}`),
    step('service.start', service !== 'running', `service ${service}`), step('record service mode', needed, `mode ${s.mode}`)]
}

export async function apply(tag: string, ctx: Context) {
  const gate = await verifyGate(tag, ctx.gateFile, ctx.clock, ctx.gateMaxAgeDays)
  if (ctx.renameTo !== undefined && !newTag.test(ctx.renameTo)) throw new CutoverError('invalid_tag', 'invalid rename tag')
  return withStateLock(ctx.stateDir, tag, ctx.ports.commandsLock, () => applyLocked(tag, ctx, gate))
}

async function applyLocked(tag: string, ctx: Context, gate: Gate) {
  const op = session(tag, ctx), { service, oldLoop } = ctx.ports
  const s = await readState(ctx.stateDir, tag)
  const old = await op.status(oldLoop), health = await op.status(service)
  if (!s.pending && s.mode === 'service' && health === 'running' && old === 'stopped') return op.report('already applied')
  await op.sync()
  Object.assign(s, { pending: 'applying', gate, renameTo: ctx.renameTo ?? s.renameTo })
  await writeState(ctx.stateDir, s)
  if (old !== 'stopped') await op.stop(oldLoop)
  if (health !== 'running') {
    try { await op.start(service) } catch (error) {
      if (error instanceof CutoverError && error.reason === 'budget_exceeded') throw error
      try {
        // A failed start command can still have started the service.
        await op.stop(service)
        await op.sync()
        await op.start(oldLoop)
        await op.finish(s, 'files', 'apply_rolled_back')
      } catch (recovery) {
        if (recovery instanceof CutoverError && recovery.reason === 'budget_exceeded') throw recovery
        throw new CutoverError('service_start_failed', 'service failed to start; automatic rollback incomplete')
      }
      throw new CutoverError('service_start_failed', 'service failed to start; automatically rolled back')
    }
  }
  return op.report('applied', await op.finish(s, 'service', 'applied'))
}

export async function rollback(tag: string, ctx: Context) {
  return withStateLock(ctx.stateDir, tag, ctx.ports.commandsLock, () => rollbackLocked(tag, ctx))
}

async function rollbackLocked(tag: string, ctx: Context) {
  const op = session(tag, ctx), { service, oldLoop } = ctx.ports
  const s = await readState(ctx.stateDir, tag)
  const health = await op.status(service), old = await op.status(oldLoop)
  const live = s.mode === 'service' && s.pending !== 'applying' && health === 'running'
  const stopNeeded = needsServiceStop(s, health)
  if (!stopNeeded && old === 'running') return op.report('already rolled back')
  s.pending = 'rolling_back'
  await writeState(ctx.stateDir, s)
  if (health !== 'stopped' && old !== 'running') await op.sync()
  if (stopNeeded) await op.stop(service)
  let stale = false
  try {
    await op.sync('files_stale', `files are stale; fix the bridge, then re-run swarm cutover rollback ${tag} --execute with the same --commands and --state-dir`)
  } catch (error) {
    if (!(error instanceof CutoverError) || error.reason !== 'files_stale') throw error
    if (!ctx.allowStale) {
      if (!live) {
        throw new CutoverError('files_stale', `files are stale; fix the bridge or re-run swarm cutover rollback ${tag} --execute --allow-stale`)
      }
      // A pending old-loop start can land during the drain. Stop it before restoring the service.
      if (old === 'running' || await op.status(oldLoop).catch(ignorePortFailure) !== 'stopped') throw error
      await op.stop(oldLoop)
      try { await op.start(service) } catch {
        throw new CutoverError('no_router', 'no router running: start the service or the old loop by hand')
      }
      delete s.pending
      s.mode = 'service'
      await writeState(ctx.stateDir, s)
      throw new CutoverError('files_stale', `rollback refused: files are stale; the service was restored; fix the bridge, then re-run swarm cutover rollback ${tag} --execute`)
    }
    stale = true
  }
  if (old !== 'running') {
    try { await op.start(oldLoop) } finally {
      // Even a failed old-loop start can land, as can a prior service start.
      try {
        if (await op.status(service).catch(ignorePortFailure) !== 'stopped') await op.stop(service)
      } catch {
        // Leave the handoff pending and try to end the overlap from the other side.
        await op.stop(oldLoop).catch(() => {})
        throw new CutoverError('both_running_detected', 'could not confirm service stopped after starting the old loop')
      }
    }
  }
  if (stale) {
    await op.finish(s, 'files', 'rolled_back_stale')
    throw new CutoverError('rolled_back_stale', 'rollback finished: files were stale; the old loop is running')
  }
  return op.report('rolled back', await op.finish(s, 'files', 'rolled_back'))
}
