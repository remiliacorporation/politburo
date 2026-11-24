import type { UsageWindow } from '@remilia/politburo-runtime'

export type BudgetRule = {
  scope: string
  dimension: string
  window: string
  warn: number
  hard: number
  action?: 'refuse_launch' | 'warn' | 'stop'
  missing_data_policy?: 'strict' | 'admit_warn' | 'reject' | 'admit_unknown' | 'reserve_worst_case'
}

type LedgerUsage = UsageWindow & { windowId?: string }
type Spend = number | 'unknown'
type Held = { ok: true; release(): Promise<void> }

export interface LedgerPort {
  usage(): Promise<LedgerUsage>
  committed(rule: BudgetRule): Promise<Spend>
  outstanding(rule: BudgetRule): Promise<number>
  reserve(rule: BudgetRule, amount: number, key: string): Promise<Held | { ok: false }>
}

export function admitsUnknown(rule: BudgetRule): boolean {
  return rule.missing_data_policy === 'admit_warn' || rule.missing_data_policy === 'admit_unknown'
}

function bucket({ scope, dimension, window }: BudgetRule): string {
  return JSON.stringify([scope, dimension, window])
}

// STUB until WP-103 lands
export function memoryLedger({ usage, committed = () => 'unknown' }: {
  usage: LedgerUsage | (() => LedgerUsage | Promise<LedgerUsage>)
  committed?: (rule: BudgetRule) => Spend
}): LedgerPort {
  const holds = new Map<string, Map<string, { amount: number; reservation: Held }>>()
  function outstanding(id: string) {
    let total = 0
    for (const hold of holds.get(id)?.values() ?? []) total += hold.amount
    return total
  }

  return {
    async usage() { return typeof usage === 'function' ? await usage() : { ...usage } },
    async committed(rule) { return committed(rule) },
    async outstanding(rule) { return outstanding(bucket(rule)) },
    async reserve(rule, amount, key) {
      if (!Number.isFinite(amount) || amount < 0) throw new RangeError('invalid budget amount')
      const id = bucket(rule)
      const entries = holds.get(id) ?? new Map()
      const existing = entries.get(key)
      if (existing && existing.amount !== amount) throw new Error('reservation key reused with a different amount')
      const spent = committed(rule)
      const pending = outstanding(id) + (existing ? 0 : amount)
      // With explicit admit-with-warning, enforce only the known lower bound.
      if (spent === 'unknown' ? !admitsUnknown(rule) || !(pending <= rule.hard)
        : !(spent + pending <= rule.hard)) return { ok: false }
      if (existing) return existing.reservation
      const reservation: Held = {
        ok: true,
        async release() {
          if (entries.get(key)?.reservation !== reservation) return
          entries.delete(key)
          if (entries.size === 0) holds.delete(id)
        },
      }
      entries.set(key, { amount, reservation })
      holds.set(id, entries)
      return reservation
    },
  }
}
