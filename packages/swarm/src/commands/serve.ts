import { serveCommand } from '../identity/serve.ts'

export const name = 'serve'
export const summary = 'serve --help'

export function run(argv: string[]): Promise<number> {
  return serveCommand(argv)
}
