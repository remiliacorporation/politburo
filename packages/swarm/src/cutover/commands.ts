import { spawn } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { CutoverError, type Ports, type ProcessPort } from './ports.ts'

type Action = 'start' | 'stop' | 'status' | 'sync'
type Commands = Partial<Record<'service' | 'oldLoop' | 'bridge', Partial<Record<Action, string[]>>>>

export async function CommandPorts(tag: string, file?: string, signal?: AbortSignal): Promise<Ports> {
  let config: Commands | undefined, commandsLock: string | undefined
  const invalid = () => new CutoverError('commands_invalid', 'invalid or missing commands for tag')
  if (file !== undefined) {
    try {
      const canonical = await realpath(file)
      config = JSON.parse(await readFile(canonical, 'utf8'))?.[tag]
      commandsLock = `${canonical}.${tag}.cutover.lock`
    } catch { throw invalid() }
    for (const group of ['service', 'oldLoop', 'bridge'] as const) {
      const actions = group === 'bridge' ? ['sync', 'status'] as const : ['start', 'stop', 'status'] as const
      for (const action of actions) {
        const argv = config?.[group]?.[action]
        if (!Array.isArray(argv) || !argv[0] || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw invalid()
      }
    }
  }
  async function invoke(group: keyof Commands, action: Action, tag: string) {
    const [program, ...args] = config?.[group]?.[action] ?? []
    if (!program) return null
    return new Promise<number | null>((resolve) => {
      const child = spawn(program, [...args, tag], { stdio: 'ignore', signal, killSignal: 'SIGKILL' })
      child.once('error', () => resolve(null))
      child.once('close', resolve)
    }).catch(() => null)
  }
  const process = (group: 'service' | 'oldLoop'): ProcessPort => {
    const mutate = (action: 'start' | 'stop') => async (tag: string) => {
      if (await invoke(group, action, tag) !== 0) throw new CutoverError('port_failed', `${group} ${action} command failed`)
    }
    return { start: mutate('start'), stop: mutate('stop'), async status(tag) {
      const code = await invoke(group, 'status', tag)
      return code === 0 ? 'running' : code === 1 ? 'stopped' : 'unknown'
    } }
  }
  return { commandsLock, service: process('service'), oldLoop: process('oldLoop'), bridge: {
    async status(tag) { return { current: await invoke('bridge', 'status', tag) === 0 } },
    async sync(tag) { return { current: await invoke('bridge', 'sync', tag) === 0 } },
  } }
}
