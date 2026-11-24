#!/usr/bin/env node
import { commandNames, loadCommand } from './commands/load.ts'
import { helpText, misuse, usage } from './cli-usage.ts'

async function dispatch(args: string[]): Promise<number> {
  const [command, action] = args
  if (args.length === 1 && command === '--help') {
    console.log(helpText())
    return 0
  }
  if (args.length === 2 && command === 'config' && action === '--help') {
    console.log(usage)
    return 0
  }
  if (command !== undefined && commandNames().has(command)) {
    return (await loadCommand(command)).run(args.slice(1))
  }
  if (command === undefined) return misuse('missing command')
  return misuse(`unknown command ${command}`)
}

process.exitCode = await dispatch(process.argv.slice(2))
