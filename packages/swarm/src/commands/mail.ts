export const name = 'mail'
export const summary = 'mail'

export async function run(argv: string[]): Promise<number> {
  if (argv[0] === 'bridge') return (await import('../mail/cli.ts')).runMail(argv)
  const { run: runCutover } = await import('../cutover/cli.ts')
  return runCutover(argv, 'mail')
}
