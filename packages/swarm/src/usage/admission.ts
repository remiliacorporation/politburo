import type { CapacityKind, CapacityPolicy, Reservation, UsageGuard } from '@remilia/politburo-runtime'
import { admitsUnknown, type BudgetRule, type LedgerPort } from './ledger-port.ts'

type Refusal = { admitted: false; cleanup_failed?: true } & (
  | { reason: 'budget_hard'; rule: BudgetRule }
  | { reason: 'budget_unknown' | 'capacity' }
)
export type Admission =
  | { admitted: true; warnings: string[]; release(): Promise<void> }
  | { admitted: false; reason: 'usage_stop'; resetAt: number }
  | Refusal

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
    for (let i = held.length - 1; i >= 0; i--) {
      try {
        await held[i]!.release()
        held.splice(i, 1)
      } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'reservation release failed')
  })().catch(error => { released = undefined; throw error })

  async function refuse(result: Refusal): Promise<Refusal> {
    try { await release() } catch { return { ...result, cleanup_failed: true } }
    return result
  }

  try {
    for (const rule of rules) {
      const name = `${rule.scope}/${rule.dimension}/${rule.window}`
      const hasAmount = Object.hasOwn(request.amounts, rule.dimension)
      if (!hasAmount) {
        if (!admitsUnknown(rule)) return refuse({ admitted: false, reason: 'budget_unknown' })
        warnings.push(`budget ${name}: request amount unknown`)
      }
      const amount = hasAmount ? request.amounts[rule.dimension]! : 0
      if (!Number.isFinite(amount) || amount < 0) throw new RangeError('invalid budget amount')
      const spent = await ledger.committed(rule)
      if (spent === 'unknown') {
        if (!admitsUnknown(rule)) return refuse({ admitted: false, reason: 'budget_unknown' })
        warnings.push(`budget ${name}: committed spend unknown`)
      }
      const reservation = await ledger.reserve(rule, amount, request.key)
      if (!reservation.ok) return refuse({ admitted: false, reason: 'budget_hard', rule })
      held.push(reservation)
      const outstanding = await ledger.outstanding(rule)
      if ((spent === 'unknown' ? outstanding : spent + outstanding) > rule.warn) {
        warnings.push(`budget ${name}: warning ceiling exceeded`)
      }
    }
    const { kind, heavy } = request
    const slot = await capacity.tryReserve(heavy === undefined ? { kind } : { kind, heavy })
    if (!slot) return refuse({ admitted: false, reason: 'capacity' })
    held.push(slot)
    return { admitted: true, warnings, release }
  } catch (error) {
    await release()
    throw error
  }
}
