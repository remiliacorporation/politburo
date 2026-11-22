import { verifyGate } from './gate.ts'
import { CutoverError, newTag, type Clock, type Ports, type ProcessPort } from './ports.ts'
import { readState, writeState, type State } from './state.ts'
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
  log?: (line: string) => void
}

function session(tag: string, ctx: Context) {
  const { ports, clock } = ctx
  const elapsed = () => clock.now() - started
  const started = clock.now(), budget = ctx.budgetMs ?? 300_000
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

export async function plan(tag: string, ctx: Context) {
  const { call, status } = session(tag, ctx), { ports: p } = ctx
  const s = await readState(ctx.stateDir, tag)
  const [service, old, bridge] = await Promise.all([status(p.service), status(p.oldLoop), call(() => p.bridge.status(tag))])
  const step = (step: string, needed: boolean, why: string) => ({ step, do: needed, why })
  if (ctx.rollback) {
    const needed = s.mode !== 'files' || !!s.pending || service !== 'stopped' || old !== 'running'
    const both = service === 'running' && old === 'running'
    const stop = step('service.stop', service !== 'stopped', `service ${service}`)
    return [step('record rollback', needed, needed ? 'rollback needed' : 'already rolled back'),
      ...(both ? [stop] : [step('bridge.sync', service !== 'stopped', `service ${service}`), stop]),
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
  const op = session(tag, ctx), { service, oldLoop } = ctx.ports
  const gate = await verifyGate(tag, ctx.gateFile, ctx.clock, ctx.gateMaxAgeDays)
  if (ctx.renameTo !== undefined && !newTag.test(ctx.renameTo)) throw new CutoverError('invalid_tag', 'invalid rename tag')
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
      const failed = () => new CutoverError('service_start_failed', 'service failed to start; automatic rollback incomplete')
      try {
        // A failed start command can still have started the service.
        if (await op.status(service).catch(ignorePortFailure) !== 'stopped') await op.stop(service)
        await op.sync()
        await op.start(oldLoop)
        await op.finish(s, 'files', 'apply_rolled_back')
      } catch (recovery) {
        if (recovery instanceof CutoverError && recovery.reason === 'budget_exceeded') throw recovery
        throw failed()
      }
      throw new CutoverError('service_start_failed', 'service failed to start; automatically rolled back')
    }
  }
  return op.report('applied', await op.finish(s, 'service', 'applied'))
}

export async function rollback(tag: string, ctx: Context) {
  const op = session(tag, ctx), { service, oldLoop } = ctx.ports
  const s = await readState(ctx.stateDir, tag)
  const health = await op.status(service), old = await op.status(oldLoop)
  if (!s.pending && s.mode === 'files' && health === 'stopped' && old === 'running') return op.report('already rolled back')
  s.pending = 'rolling_back'
  await writeState(ctx.stateDir, s)
  if (health !== 'stopped') {
    if (!(health === 'running' && old === 'running')) await op.sync()
    await op.stop(service)
  }
  await op.sync('files_stale', `files are stale; fix the bridge, then re-run swarm cutover rollback ${tag} --execute`)
  if (old !== 'running') await op.start(oldLoop)
  return op.report('rolled back', await op.finish(s, 'files', 'rolled_back'))
}
