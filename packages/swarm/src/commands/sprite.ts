import { run as runRoutes } from '../sprite/routes.ts'

export const name = 'sprite'
export const summary = 'sprite routes [--party FILE] [--repo FILE]'

export function run(argv: string[]): Promise<number> {
  return runRoutes(argv)
}
