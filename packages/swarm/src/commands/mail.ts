export const name = 'mail'
export const summary = 'mail a person\'s task reply to the agent working it'
export const usageOrder = 74
export const usage = ['swarm mail relay --board URL [--once]']

export async function run(argv: string[]): Promise<number> {
  if (argv[0] === 'relay') return (await import('../mail/task-relay.ts')).relayCommand(argv)
  if (argv[0] === 'bridge') return (await import('../mail/cli.ts')).runMail(argv)
  const { run: runCutover } = await import('../cutover/cli.ts')
  return runCutover(argv, 'mail')
}
