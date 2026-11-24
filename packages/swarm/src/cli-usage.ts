import type { Command } from './commands/load.ts'

let catalogText: Promise<string> | undefined

export function usageBlock(lines: readonly string[]): string {
  return lines.map((line, index) => `${index === 0 ? 'usage: ' : '       '}${line}`).join('\n')
}

function byOrder(left: Command, right: Command): number {
  return (left.usageOrder ?? 0) - (right.usageOrder ?? 0) || left.name.localeCompare(right.name)
}

function linesOf(commands: readonly Command[], catalog: boolean): Command[] {
  return commands.filter((command) => command.usage.length > 0 && command.catalog === catalog).sort(byOrder)
}

export function usageText(commands: readonly Command[]): string {
  return usageBlock(linesOf(commands, true).flatMap((command) => command.usage))
}

export function helpText(commands: readonly Command[]): string {
  const blocks = [usageText(commands), ...linesOf(commands, false).map((command) => usageBlock(command.usage))]
  return blocks.filter((block) => block !== '').join('\n')
}

export function bindUsage(commands: readonly Command[]) {
  const text = usageText(commands)
  catalogText = Promise.resolve(text)
}

export function printError(headline: string) {
  const safe = headline.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
  console.error(`error: ${safe}`)
}

export async function misuse(message: string): Promise<number> {
  printError(message)
  if (catalogText === undefined) {
    const { loadCommands } = await import('./commands/load.ts')
    catalogText = loadCommands().then(usageText)
  }
  console.error(await catalogText)
  return 2
}
