import { instructionCommand } from '../instruction/verify.ts'

export const name = 'instruction'
export const summary = 'instruction verify <message-id> --from <handle>'
export const usageOrder = 73
export const usage = ['swarm instruction verify <message-id> --from <handle> [--board URL]']

export function run(argv: string[]): Promise<number> {
  return instructionCommand(argv)
}
