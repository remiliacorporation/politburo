import type { CapacityKind, CapacityPolicy, Reservation, UsageGuard } from '@remilia/politburo-runtime'
import { admitsUnknown, type BudgetRule, type LedgerPort } from './ledger-port.ts'

export type Admission =
  | { admitted: true; warnings: string[]; release(): Promise<void> }
  | { admitted: false; reason: 'usage_stop'; resetAt: number }
  | { admitted: false; reason: 'budget_hard'; rule: BudgetRule }
  | { admitted: false; reason: 'budget_unknown' | 'capacity' }

export async function admit({ guard, wake, ledger, capacity, rules, request }: {
  guard: UsageGuard
  wake: { arm(resetAt: number): void | Promise<void> }
  ledger: LedgerPort
  capacity: CapacityPolicy
  rules: BudgetRule[]
  request: { kind: CapacityKind; heavy?: boolean; amounts: Record<string, number>; key: string }
}): Promise<Admission> {
  const decision = await guard.check()
  if (!decision.allowed) {
    await wake.arm(decision.resetAt)
    return { admitted: false, reason: 'usage_stop', resetAt: decision.resetAt }
  }

  const warnings: string[] = []
  const held: Reservation[] = []
  let released: Promise<void> | undefined
  const release = () => released ??= (async () => {
    const errors: unknown[] = []
    while (held.length) {
      try { await held.pop()!.release() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'reservation release failed')
  })()

  let admitted = false
  try {
    // The caller selects scopes; the request selects the metered dimensions.
    for (const rule of rules) {
      if (!Object.hasOwn(request.amounts, rule.dimension)) continue
      const amount = request.amounts[rule.dimension]!
      if (!Number.isFinite(amount) || amount < 0) throw new RangeError('invalid budget amount')
      const name = `${rule.scope}/${rule.dimension}/${rule.window}`
      const spent = await ledger.committed(rule)
      if (spent === 'unknown') {
        if (!admitsUnknown(rule)) return { admitted: false, reason: 'budget_unknown' }
        warnings.push(`budget ${name}: committed spend unknown`)
      }
      const reservation = await ledger.reserve(rule, amount, request.key)
      if (!reservation.ok) return { admitted: false, reason: 'budget_hard', rule }
      held.push(reservation)
      const outstanding = await ledger.outstanding(rule)
      if ((spent === 'unknown' ? outstanding : spent + outstanding) > rule.warn) {
        warnings.push(`budget ${name}: warning ceiling exceeded`)
      }
    }
    const { kind, heavy } = request
    const slot = await capacity.tryReserve(heavy === undefined ? { kind } : { kind, heavy })
    if (!slot) return { admitted: false, reason: 'capacity' }
    held.push(slot)
    admitted = true
    return { admitted: true, warnings, release }
  } finally {
    if (!admitted) await release()
  }
}
