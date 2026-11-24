import { ledgerCommand } from '../ledger/cli.ts'

export const name = 'ledger'
export const summary = 'ledger <dispatch|append|rollup> --db FILE [options]'
export const usageOrder = 15
export const usage = ['swarm ledger <dispatch|append|rollup> --db FILE [options]']

export function run(argv: string[]): number {
  return ledgerCommand(argv)
}
