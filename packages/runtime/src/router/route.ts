import { randomUUID } from 'node:crypto'
import type { WorkSpec } from '../harness.ts'
import { duration, failures, isAmount, isName, modelKey, snapshotWork, verifies, type AttemptContract, type AttemptResult, type Evidence, type RouteModel } from './contract.ts'
import type { AttemptSample, ModelScore, ModelScoreboard } from './scoreboard.ts'

export type RoutingMode = 'quality' | 'cost' | 'latency'
export type RouterOptions = {
  models: readonly RouteModel[]
  scoreboard: ModelScoreboard
  execute(attempt: AttemptContract, signal: AbortSignal): Promise<AttemptResult>
  /** An access check on the existing account. No credentials or work contract are passed. */
  probes?: Readonly<Record<string, (signal: AbortSignal) => Promise<boolean>>>
  cooldownMs: Readonly<{ quota: number; auth: number; timeout: number }>
  probeTimeoutMs: number
  maxAttempts: number
  /** Monotonic time, in milliseconds. */
  now?: () => number
}

export type RouteRequest = Readonly<{ taskId: string; work: WorkSpec; mode: RoutingMode }>
export type RoutedAttempt = AttemptSample & Readonly<{ chargedMicros: number }>
export type RouteOutcome = Readonly<{ attempts: readonly RoutedAttempt[]; chargedMicros: number }> & (
  | { status: 'verified'; evidence: Evidence }
  | { status: 'stopped'; reason: 'busy' | 'unavailable' | 'attempt-limit' | 'budget-exhausted' | 'budget-overrun' | 'execution-uncertain' | 'verification-failed' }
)

async function bounded<T>(ms: number, run: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<{ status: 'timeout' }>((resolve) => {
      timer = setTimeout(() => {
        resolve({ status: 'timeout' })
        controller.abort()
      }, ms)
    })
    const result = Promise.resolve().then(() => run(controller.signal)).then(
      (value) => ({ status: 'returned', value }) as const,
      () => ({ status: 'uncertain' }) as const,
    )
    const settled = await Promise.race([deadline, result])
    if (settled.status === 'uncertain') controller.abort()
    return settled
  } finally {
    clearTimeout(timer)
  }
}

/** The host owns the task lease and the executor; the router only returns a routing outcome. */
export function createRouter(options: RouterOptions): (request: RouteRequest) => Promise<RouteOutcome> {
  const { scoreboard, execute, now = () => performance.now(), maxAttempts } = options
  if (!isAmount(maxAttempts) || maxAttempts < 1) throw new RangeError('invalid maxAttempts')
  const probeTimeout = duration(options.probeTimeoutMs, 'probeTimeoutMs')
  const quota = duration(options.cooldownMs.quota, 'quota cooldown')
  const auth = duration(options.cooldownMs.auth, 'auth cooldown')
  const timeout = duration(options.cooldownMs.timeout, 'timeout cooldown')
  const models = options.models.map(({ provider, model, maxCostMicros }) => {
    if (!isName(provider) || !isName(model) || !isAmount(maxCostMicros)) throw new TypeError('invalid route model')
    return Object.freeze({ provider, model, maxCostMicros })
  })
  if (new Set(models.map(modelKey)).size !== models.length) throw new TypeError('duplicate route model')
  const probes = new Map(Object.entries(options.probes ?? {}))
  const access = new Map<string, { readyAt: number; tried: boolean }>()
  const quotaUntil = new Map<string, number>()
  const timeoutUntil = new Map<string, number>()
  const active = new Set<string>()

  function eligible(target: RouteModel) {
    const at = now()
    if (at < (quotaUntil.get(target.provider) ?? -Infinity) || at < (timeoutUntil.get(modelKey(target)) ?? -Infinity)) return false
    const incident = access.get(target.provider)
    return !incident || (!incident.tried && incident.readyAt <= at && probes.has(target.provider))
  }

  async function recover(provider: string) {
    const incident = access.get(provider)
    if (!incident) return true
    const probe = probes.get(provider)
    if (incident.tried || incident.readyAt > now() || !probe) return false
    incident.tried = true // Reserve before yielding to another route.
    const result = await bounded(probeTimeout, probe)
    if (result.status !== 'returned' || result.value !== true) return false
    access.delete(provider)
    return true
  }

  return async ({ taskId, work: input, mode }) => {
    if (!taskId || !['quality', 'cost', 'latency'].includes(mode)) throw new TypeError('invalid route request')
    if (active.has(taskId)) return { status: 'stopped', reason: 'busy', attempts: [], chargedMicros: 0 }
    const work = snapshotWork(input)
    const attempts: RoutedAttempt[] = []
    const used = new Set<string>()
    let chargedMicros = 0
    const stop = (reason: Extract<RouteOutcome, { status: 'stopped' }>['reason']): RouteOutcome =>
      ({ status: 'stopped', reason, attempts, chargedMicros })

    active.add(taskId)
    try {
      const scores = new Map((await scoreboard.read()).map((score) => [modelKey(score), score]))
      const ranked = models.slice().sort((a, b) => value(b) - value(a))
      function value(model: RouteModel) {
        const score: ModelScore | undefined = scores.get(modelKey(model))
        if (mode === 'cost') return -(score?.meanCostMicros ?? model.maxCostMicros)
        if (mode === 'latency') return -(score?.meanLatencyMs ?? Number.MAX_SAFE_INTEGER)
        return score?.successRate ?? -1
      }

      while (attempts.length < maxAttempts) {
        const available = ranked.filter((model) => !used.has(modelKey(model)) && eligible(model))
        if (!available.length) return stop('unavailable')
        const target = available.find((model) => model.maxCostMicros <= work.limits.maxCostMicros - chargedMicros)
        if (!target) return stop('budget-exhausted')
        // Only yield for recovery. Availability and dispatch are otherwise checked in the same turn.
        if (access.has(target.provider)) {
          if (!await recover(target.provider) || access.has(target.provider) || !eligible(target)) continue
        }

        const key = modelKey(target)
        used.add(key)
        const attempt = Object.freeze({ taskId, attemptId: randomUUID(), target, work })
        const start = now()
        const run = await bounded(work.limits.wallMs, (signal) => execute(attempt, signal))
        const latencyMs = Math.max(0, Math.round(now() - start))
        const result = run.status === 'returned' ? run.value : undefined
        const costMicros = isAmount(result?.costMicros) ? result.costMicros : null
        const invalidCost = result?.costMicros !== null && costMicros === null
        // The reservation is all we can book against the budget. Keep any observed overrun in the sample.
        const charge = Math.min(costMicros ?? target.maxCostMicros, target.maxCostMicros)
        chargedMicros += charge
        const overrun = costMicros !== null && costMicros > target.maxCostMicros
        const evidence = result?.outcome === 'candidate' ? result.evidence : undefined
        const outcome = run.status === 'timeout' ? 'timeout' :
          result?.outcome === 'candidate' ? (invalidCost ? 'bad-output' : verifies(work, evidence) ? 'verified' : 'verification-failed') :
          result && failures.includes(result.outcome) ? result.outcome : 'bad-output'
        if (outcome === 'quota') quotaUntil.set(target.provider, now() + quota)
        if (outcome === 'timeout') timeoutUntil.set(key, now() + timeout)
        if (outcome === 'auth' && !access.has(target.provider)) access.set(target.provider, { readyAt: now() + auth, tried: false })
        const sample: AttemptSample = {
          provider: target.provider, model: target.model, attemptId: attempt.attemptId,
          outcome: overrun && outcome === 'verified' ? 'bad-output' : outcome,
          costMicros, latencyMs,
        }
        attempts.push({ ...sample, chargedMicros: charge })
        const verified = !overrun && outcome === 'verified' && evidence ? {
          baseSha: evidence.baseSha, headSha: evidence.headSha,
          changedPaths: [...evidence.changedPaths], passedCheckIds: [...evidence.passedCheckIds],
        } : undefined
        await scoreboard.record(sample)
        if (overrun) return stop('budget-overrun')
        // A watchdog or thrown executor cannot prove the original work stopped.
        if (run.status !== 'returned') return stop('execution-uncertain')
        if (verified) return { status: 'verified', evidence: verified, attempts, chargedMicros }
        if (outcome === 'verification-failed') return stop('verification-failed')
      }
      return stop('attempt-limit')
    } finally {
      active.delete(taskId)
    }
  }
}
