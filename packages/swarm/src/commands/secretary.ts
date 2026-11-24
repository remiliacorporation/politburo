import { secretaryMain } from '../secretary/cli.ts'

export const name = 'secretary'
export const summary = 'secretary'

export function run(argv: string[]): Promise<number> {
  return secretaryMain(argv)
}
