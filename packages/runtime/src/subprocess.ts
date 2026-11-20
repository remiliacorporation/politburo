import { processHarness } from './process.ts'

/** Run a fixed, trusted command without a shell or inherited credentials. POSIX only. */
export function subprocess({ command, args = [] }: { command: string; args?: readonly string[] }) {
  const invocation = { command, args: [...args] }
  return processHarness({ interactive: true, prepare: () => [invocation] })
}
