import { gateCommand } from '../gate/cli.ts'

export const name = 'gate'
export const summary = 'gate check <pr-number> --board URL'
export const usageOrder = 72
export const usage = ['swarm gate check <pr-number> --board URL']

export function run(argv: string[]): Promise<number> {
  return gateCommand(argv)
}
