import { attachCommand } from '../trace/attach.ts'

export const name = 'trace'
export const summary = 'attach a transcript, log, or ci file to a task'
export const usageOrder = 75
export const usage = ['swarm trace attach <task-id> --kind transcript|log|ci --file PATH [--source URL] [--board URL]']

export function run(argv: string[]): Promise<number> {
  return attachCommand(argv)
}
