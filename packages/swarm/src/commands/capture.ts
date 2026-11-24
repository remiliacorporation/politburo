import { captureMain } from '../capture/cli.ts'

export const name = 'capture'
export const summary = 'capture <run|collect>'
export const usageOrder = 60
export const usage = ['swarm capture <run|collect>']

export function run(argv: string[]): Promise<number> {
  return captureMain(argv)
}
