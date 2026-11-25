import { spawnSync } from 'node:child_process'
import {
  existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, type Dirent,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export class HostStatusError extends Error {}

export type Row = { kind: 'daemon' | 'agent' | 'port' | 'board' | 'skipped'; name: string; detail: string }

const MENTION = /(?:^|[^a-z0-9])(?:board|politburo|cloudflared)(?=$|[^a-z0-9])/i
const HOLDERS = new Set(['node', 'cloudflared'])

/** `node` or `cloudflared`, from a thread name or an executable path. Node 24 names its main thread `MainThread`. */
function holderName(name: string): string | null {
  const base = name.split(/[/\\]/).pop()?.replace(/\.exe$/i, '') ?? ''
  return HOLDERS.has(base) ? base : null
}
const SECRET = /(token|secret|password|api[-_]?key|authorization)/i

function safe(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function decodeXml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
}

function mentions(label: string | null, program: readonly string[]): boolean {
  return MENTION.test(label ?? '') || program.some((arg) => MENTION.test(arg))
}

function redact(args: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const eq = arg.indexOf('=')
    if (eq > 0 && SECRET.test(arg.slice(0, eq).replace(/^-+/, ''))) {
      out.push(`${arg.slice(0, eq + 1)}<redacted>`)
      continue
    }
    const flag = arg.replace(/^-+/, '')
    if (SECRET.test(flag) && !flag.includes('=')) {
      out.push(arg)
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        out.push('<redacted>')
        i++
      }
      continue
    }
    out.push(arg)
  }
  return out
}

function showArg(arg: string): string {
  return /[\s"]/.test(arg) ? JSON.stringify(arg) : arg
}

function programDetail(program: readonly string[]): string {
  const shown = redact(program).map(showArg).join(' ')
  return shown === '' ? '-' : shown
}

/** Label and program from an XML plist. Environment dictionaries and comments are ignored. */
export function plistProgram(xml: string): { label: string | null; program: string[] } | null {
  const stripped = xml.replace(/<!--[\s\S]*?-->/g, '')
  const keys = /<key>([\s\S]*?)<\/key>\s*(?:<string>([\s\S]*?)<\/string>|<array>([\s\S]*?)<\/array>)/g
  let label: string | null = null
  let program: string | null = null
  let args: string[] | null = null
  for (const match of stripped.matchAll(keys)) {
    const key = decodeXml(match[1]!).trim()
    if (key === 'Label' && match[2] !== undefined && label === null) label = decodeXml(match[2])
    if (key === 'Program' && match[2] !== undefined && program === null) program = decodeXml(match[2])
    if (key === 'ProgramArguments' && match[3] !== undefined && args === null) {
      args = [...match[3].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((part) => decodeXml(part[1]!))
    }
  }
  const argv = args && args.length > 0 ? args : program !== null ? [program] : []
  if (label === null && argv.length === 0) return null
  return { label, program: argv }
}

function domainOf(dir: string): 'daemon' | 'agent' {
  return dir.split(/[/\\]/).includes('LaunchAgents') ? 'agent' : 'daemon'
}

function jobsIn(dir: string, kind: 'daemon' | 'agent'): { rows: Row[]; skipped: Row[] } {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    throw new HostStatusError(`cannot read ${dir}`)
  }
  const rows: Row[] = []
  const skipped: Row[] = []
  for (const entry of entries) {
    if (!entry.name.endsWith('.plist') || entry.isSymbolicLink()) continue
    const path = join(dir, entry.name)
    let bytes: Buffer
    try {
      if (lstatSync(path).isSymbolicLink()) continue
      bytes = readFileSync(path)
    } catch {
      skipped.push({ kind: 'skipped', name: path, detail: 'cannot read' })
      continue
    }
    const text = plistText(path, bytes)
    const parsed = text === null ? null : plistProgram(text)
    if (parsed) {
      if (!mentions(parsed.label, parsed.program)) continue
      rows.push({
        kind, name: parsed.label ?? entry.name.slice(0, -'.plist'.length), detail: programDetail(parsed.program),
      })
      continue
    }
    const raw = bytes.toString('utf8')
    if (!MENTION.test(raw.replace(/<!--[\s\S]*?-->/g, ''))) continue
    rows.push({ kind, name: entry.name.slice(0, -'.plist'.length), detail: 'binary plist' })
  }
  return { rows, skipped }
}

function plistText(path: string, bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).toString('utf8') !== 'bplist00') return bytes.toString('utf8')
  const converted = spawnSync('plutil', ['-convert', 'xml1', '-o', '-', path], { encoding: 'utf8', timeout: 5_000 })
  if (converted.status === 0 && converted.stdout) return converted.stdout
  return null
}

export function defaultLaunchdDirs(): string[] {
  const dirs = [
    '/Library/LaunchDaemons',
    '/Library/LaunchAgents',
    '/System/Library/LaunchDaemons',
    '/System/Library/LaunchAgents',
    join(homedir(), 'Library', 'LaunchAgents'),
  ]
  if (existsSync('/Users')) {
    let users: string[]
    try {
      users = readdirSync('/Users')
    } catch {
      users = []
    }
    for (const user of users) {
      dirs.push(join('/Users', user, 'Library', 'LaunchAgents'))
      dirs.push(join('/Users', user, 'Library', 'LaunchDaemons'))
    }
  }
  return [...new Set(dirs)]
}

function readLaunchd(dirs: readonly string[] | undefined): { rows: Row[]; skipped: Row[] } {
  const chosen = dirs ?? defaultLaunchdDirs()
  const rows: Row[] = []
  const skipped: Row[] = []
  for (const dir of chosen) {
    if (dirs === undefined && !existsSync(dir)) continue
    const found = jobsIn(dir, domainOf(dir))
    rows.push(...found.rows)
    skipped.push(...found.skipped)
  }
  rows.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'daemon' ? -1 : 1)
    || a.name.localeCompare(b.name) || a.detail.localeCompare(b.detail))
  return { rows, skipped }
}

function ipv4(hex: string): string {
  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 8) {
    const word = hex.slice(i, i + 8)
    for (let j = 6; j >= 0; j -= 2) bytes.push(parseInt(word.slice(j, j + 2), 16))
  }
  return bytes.join('.')
}

function ipv6(hex: string): string {
  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 8) {
    const word = hex.slice(i, i + 8)
    for (let j = 6; j >= 0; j -= 2) bytes.push(parseInt(word.slice(j, j + 2), 16))
  }
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 255 && bytes[11] === 255) {
    return `::ffff:${bytes.slice(12).join('.')}`
  }
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16))
  let start = -1
  let length = 0
  for (let i = 0; i < groups.length;) {
    if (groups[i] !== '0') { i++; continue }
    let j = i
    while (j < groups.length && groups[j] === '0') j++
    if (j - i > length) { start = i; length = j - i }
    i = j
  }
  if (length < 2) return groups.join(':')
  return `${groups.slice(0, start).join(':')}::${groups.slice(start + length).join(':')}`
}

type Socket = { address: string; port: number; inode: string }

/** Listening TCP rows from `/proc/net/tcp` or `tcp6`. The inode is the tenth field. */
export function parseProcNet(text: string, family: 4 | 6): Socket[] {
  const sockets: Socket[] = []
  for (const line of text.split('\n')) {
    const field = line.trim().split(/\s+/)
    if (field[3] !== '0A' || field.length < 10) continue
    const [address, port] = (field[1] ?? '').split(':')
    if (!address || !port) continue
    sockets.push({
      address: family === 4 ? ipv4(address) : ipv6(address),
      port: parseInt(port, 16),
      inode: field[9]!,
    })
  }
  return sockets
}

function endpoint(address: string, port: number): string {
  return `${address.includes(':') ? `[${address}]` : address}:${port}`
}

function procPorts(root: string): Row[] {
  const sockets = new Map<string, Socket[]>()
  for (const [file, family] of [['tcp', 4], ['tcp6', 6]] as const) {
    let text: string
    try {
      text = readFileSync(join(root, 'net', file), 'utf8')
    } catch (error) {
      if (file === 'tcp') throw new HostStatusError(`cannot read ${join(root, 'net', file)}`)
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new HostStatusError(`cannot read ${join(root, 'net', file)}`)
    }
    for (const socket of parseProcNet(text, family)) {
      const list = sockets.get(socket.inode) ?? []
      list.push(socket)
      sockets.set(socket.inode, list)
    }
  }
  let pids: string[]
  try {
    pids = readdirSync(root).filter((name) => /^\d+$/.test(name))
  } catch {
    throw new HostStatusError(`cannot read ${root}`)
  }
  const rows: Row[] = []
  const seen = new Set<string>()
  for (const pid of pids) {
    let comm: string
    try {
      comm = readFileSync(join(root, pid, 'comm'), 'utf8').trim()
    } catch {
      continue
    }
    let executable = ''
    try {
      executable = readlinkSync(join(root, pid, 'exe'))
    } catch { /* the thread name decides */ }
    if (holderName(comm) === null && holderName(executable) === null) continue
    let fds: string[]
    try {
      fds = readdirSync(join(root, pid, 'fd'))
    } catch {
      continue
    }
    const held: Socket[] = []
    for (const fd of fds) {
      let link: string
      try {
        link = readlinkSync(join(root, pid, 'fd', fd))
      } catch {
        continue
      }
      const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1]
      if (!inode) continue
      for (const socket of sockets.get(inode) ?? []) {
        const key = `${pid}\0${socket.address}\0${socket.port}`
        if (seen.has(key)) continue
        seen.add(key)
        held.push(socket)
      }
    }
    if (!held.length) continue
    let args = [comm]
    try {
      const parsed = readFileSync(join(root, pid, 'cmdline')).toString('utf8').split('\0').filter((part) => part !== '')
      if (parsed.length) args = parsed
    } catch { /* the command name is enough */ }
    const detail = `pid ${pid}  ${redact(args).map(showArg).join(' ')}`
    for (const socket of held) {
      rows.push({ kind: 'port', name: endpoint(socket.address, socket.port), detail })
    }
  }
  rows.sort((a, b) => {
    const port = (name: string) => Number(name.slice(name.lastIndexOf(':') + 1))
    return port(a.name) - port(b.name) || a.name.localeCompare(b.name) || a.detail.localeCompare(b.detail)
  })
  return rows
}

function parseLsof(text: string): { pid: string; command: string; address: string; port: number }[] {
  const found: { pid: string; command: string; address: string; port: number }[] = []
  let pid = ''
  let command = ''
  for (const line of text.split('\n')) {
    const id = line[0]
    const value = line.slice(1)
    if (id === 'p') { pid = value; command = '' }
    else if (id === 'c') command = value
    else if (id === 'n') {
      const match = /^(.*):(\d+)$/.exec(value)
      if (!match) continue
      let address = match[1]!
      if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
      found.push({ pid, command, address, port: Number(match[2]) })
    }
  }
  return found
}

function lsofPorts(): Row[] {
  const listed = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], { encoding: 'utf8', timeout: 10_000 })
  if (listed.error || listed.status !== 0) throw new HostStatusError('cannot list listening ports')
  const found = parseLsof(listed.stdout)
  const argsOf = new Map<string, string[]>()
  const pids = [...new Set(found.map((row) => row.pid))]
  if (pids.length) {
    const args = spawnSync('ps', ['-ww', '-o', 'pid=,args=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 5_000 })
    if (args.status === 0) {
      for (const line of args.stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line)
        if (!match) continue
        argsOf.set(match[1]!, match[2]!.split(/\s+/))
      }
    }
  }
  return found.flatMap((row) => {
    const args = argsOf.get(row.pid) ?? [row.command]
    if (holderName(row.command) === null && holderName(args[0] ?? '') === null) return []
    return [{
      kind: 'port' as const,
      name: endpoint(row.address, row.port),
      detail: `pid ${row.pid}  ${redact(args).map(showArg).join(' ')}`,
    }]
  }).sort((a, b) => {
    const port = (name: string) => Number(name.slice(name.lastIndexOf(':') + 1))
    return port(a.name) - port(b.name) || a.name.localeCompare(b.name) || a.detail.localeCompare(b.detail)
  })
}

function listening(proc: string | undefined): Row[] {
  if (proc !== undefined) return procPorts(proc)
  if (existsSync('/proc/net/tcp')) return procPorts('/proc')
  return lsofPorts()
}

function boardRows(root: string): { rows: Row[]; skipped: Row[] } {
  let info
  try {
    info = lstatSync(root)
  } catch {
    throw new HostStatusError(`cannot read ${root}`)
  }
  if (!info.isDirectory()) throw new HostStatusError(`cannot read ${root}`)
  const rows: Row[] = []
  const skipped: Row[] = []
  const walk = (dir: string) => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      skipped.push({ kind: 'skipped', name: dir, detail: 'cannot read' })
      return
    }
    const databases: string[] = []
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(join(dir, entry.name))
      else if (entry.isFile() && entry.name.endsWith('.db')) databases.push(entry.name)
    }
    if (databases.length) {
      rows.push({ kind: 'board', name: dir, detail: databases.sort().join(' ') })
    }
  }
  walk(root)
  rows.sort((a, b) => a.name.localeCompare(b.name))
  skipped.sort((a, b) => a.name.localeCompare(b.name))
  return { rows, skipped }
}

export function collect(options: { root: string; launchd?: readonly string[]; proc?: string }): Row[] {
  const boards = boardRows(options.root)
  const jobs = readLaunchd(options.launchd)
  const ports = listening(options.proc)
  return [
    ...jobs.rows,
    ...ports,
    ...boards.rows,
    ...jobs.skipped,
    ...boards.skipped,
  ]
}

export function toText(rows: readonly Row[]): string {
  const body = [['kind', 'name', 'detail'], ...rows.map((row) => [safe(row.kind), safe(row.name), safe(row.detail)])]
  const widths = body[0]!.map((_, index) => Math.max(...body.map((line) => line[index]!.length)))
  return `${body.map((line) => line.map((cell, index) => index === line.length - 1 ? cell : cell.padEnd(widths[index]!)).join('  ').trimEnd()).join('\n')}\n`
}

export function toJson(rows: readonly Row[]): string {
  return `${JSON.stringify({ rows }, null, 2)}\n`
}
