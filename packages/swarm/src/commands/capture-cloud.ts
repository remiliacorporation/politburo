import { captureCloud } from '../capture-cloud/cli.ts'

export const name = 'capture-cloud'
export const summary = 'capture-cloud <serve|issue|bind>'
export const usageOrder = 65
export const usage = ['swarm capture-cloud <serve|issue|bind>']

export function run(argv: string[]): Promise<number> {
  return captureCloud(argv)
}
