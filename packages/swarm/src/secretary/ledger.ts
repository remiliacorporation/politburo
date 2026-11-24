export type LedgerQuery = { tag: string; sinceMs: number; untilMs: number }
export type LedgerValue = number | 'unknown'

export interface LedgerReader {
  tokens(q: LedgerQuery): Promise<LedgerValue>
  mergedPrs(q: LedgerQuery): Promise<LedgerValue>
}

// STUB until the WP-103 spend ledger lands.
export const unknownLedger: LedgerReader = {
  async tokens() { return 'unknown' },
  async mergedPrs() { return 'unknown' },
}
