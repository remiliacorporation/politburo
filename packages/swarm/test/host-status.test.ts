import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

const envSecret = 'ENVSECRET'
const flagSecret = 'FLAGSECRET'
const quietSecret = 'QUIETSECRET'

function run(args: string[]) {
  const result = spawnSync(process.execPath, ['src/cli.ts', ...args], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: tmpdir() },
  })
  if (result.error) throw result.error
  return result
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, index) => Math.max(...rows.map((row) => row[index]!.length)))
  return `${rows.map((row) => row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths[index]!)).join('  ').trimEnd()).join('\n')}\n`
}

function plist(label: string, args: string[], extra = ''): string {
  const lines = args.map((arg) => `<string>${arg}</string>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${lines}</array>
  <!-- ${envSecret} -->
  <key>EnvironmentVariables</key><dict><key>TOKEN</key><string>${envSecret} board</string></dict>
  ${extra}
</dict></plist>
`
}

function ipv4(ip: string, port: number): string {
  const hex = ip.split('.').map(Number).reverse().map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.toUpperCase()}:${port.toString(16).toUpperCase().padStart(4, '0')}`
}

function tcp(local: string, state: string, inode: number): string {
  return `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 ${inode} 1 0000000000000000 100 0 0 10 0\n`
}

function procFile(dir: string, pid: string, comm: string, args: string[], sockets: number[], exe?: string) {
  const pidDir = join(dir, pid)
  mkdirSync(join(pidDir, 'fd'), { recursive: true })
  writeFileSync(join(pidDir, 'comm'), `${comm}\n`)
  writeFileSync(join(pidDir, 'cmdline'), `${args.join('\0')}\0`)
  writeFileSync(join(pidDir, 'environ'), `${envSecret}\0`)
  chmodSync(join(pidDir, 'environ'), 0)
  if (exe !== undefined) symlinkSync(exe, join(pidDir, 'exe'))
  sockets.forEach((inode, index) => symlinkSync(`socket:[${inode}]`, join(pidDir, 'fd', String(index + 3))))
}

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-host-'))
  t.after(() => {
    chmodSync(join(dir, 'root', 'locked'), 0o755)
    chmodSync(join(dir, 'secret.env'), 0o644)
    chmodSync(join(dir, 'root', 'team', 'api-token'), 0o644)
    chmodSync(join(dir, 'root', 'team', 'service.env'), 0o644)
    rmSync(dir, { recursive: true, force: true })
  })
  const root = join(dir, 'root')
  const daemons = join(dir, 'LaunchDaemons')
  const agents = join(dir, 'LaunchAgents')
  const proc = join(dir, 'proc')
  mkdirSync(join(root, 'team'), { recursive: true })
  mkdirSync(join(root, 'nested', 'project', '.board'), { recursive: true })
  mkdirSync(join(root, 'notes'))
  mkdirSync(join(root, 'locked'))
  mkdirSync(daemons)
  mkdirSync(agents)
  mkdirSync(join(proc, 'net'), { recursive: true })
  writeFileSync(join(root, 'team', 'local.db'), '')
  writeFileSync(join(root, 'team', 'local.db-wal'), '')
  writeFileSync(join(root, 'team', 'api-token'), envSecret)
  writeFileSync(join(root, 'team', 'service.env'), envSecret)
  chmodSync(join(root, 'team', 'api-token'), 0)
  chmodSync(join(root, 'team', 'service.env'), 0)
  writeFileSync(join(root, 'nested', 'project', '.board', 'party.db'), '')
  writeFileSync(join(root, 'notes', 'readme.txt'), envSecret)
  chmodSync(join(root, 'locked'), 0)
  const outside = join(dir, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'local.db'), envSecret)
  symlinkSync(outside, join(root, 'linked'))
  writeFileSync(join(daemons, 'org.example.politburo.board-party.plist'), plist(
    'org.example.politburo.board-party',
    ['/opt/node', '--token', flagSecret, '/opt/politburo/packages/board/dist/cli.mjs', 'serve', '/etc/politburo/board-party.env'],
  ))
  writeFileSync(join(daemons, 'com.example.tunnel.plist'), plist('com.example.tunnel', ['/usr/bin/cloudflared']))
  writeFileSync(join(daemons, 'com.example.logger.plist'), plist('com.example.logger', ['/usr/bin/logger']))
  writeFileSync(join(daemons, 'com.apple.dashboard.plist'), plist('com.apple.dashboard', ['/usr/bin/dashboard']))
  writeFileSync(join(daemons, 'com.example.cloudflared-old.plist'), `bplist00\n/usr/bin/cloudflared\n${envSecret}\n`)
  writeFileSync(join(dir, 'secret.env'), `${envSecret}\n`)
  chmodSync(join(dir, 'secret.env'), 0)
  symlinkSync(join(dir, 'secret.env'), join(daemons, 'board-secret.plist'))
  writeFileSync(join(agents, 'com.cloudflare.cloudflared.plist'), plist(
    'com.cloudflare.cloudflared', ['/usr/local/bin/cloudflared', 'tunnel'],
  ))
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
  writeFileSync(join(proc, 'net', 'tcp'), header
    + tcp(ipv4('127.0.0.1', 4101), '0A', 100)
    + tcp(ipv4('127.0.0.1', 5999), '0A', 200)
    + tcp(ipv4('127.0.0.1', 7844), '0A', 300)
    + tcp(ipv4('127.0.0.1', 4101), '01', 400)
    + tcp(ipv4('127.0.0.1', 7000), '0A', 500)
    + tcp(ipv4('127.0.0.1', 4103), '0A', 600)
    + tcp(ipv4('127.0.0.1', 4104), '0A', 700))
  writeFileSync(join(proc, 'net', 'tcp6'), header + tcp('00000000000000000000000001000000:1006', '0A', 101))
  procFile(proc, '42', 'node', ['/opt/node', '--token', flagSecret, 'serve'], [100, 101, 400])
  procFile(proc, '7', 'python', ['python', 'serve'], [200])
  procFile(proc, '9', 'cloudflared', ['/usr/bin/cloudflared', 'tunnel'], [300])
  procFile(proc, '8', 'nodemon', ['nodemon', 'serve'], [500])
  procFile(proc, '99', 'node', ['/opt/node', '--token', quietSecret], [])
  procFile(proc, '15', 'MainThread', ['/usr/local/bin/node', '--token', flagSecret, 'serve'], [600], '/usr/local/bin/node')
  procFile(proc, '16', 'MainThread', ['/usr/bin/python', 'serve'], [700], '/usr/bin/python')
  return { dir, root, daemons, agents, proc }
}

function rowsOf(fixtureDir: ReturnType<typeof fixture>) {
  const board = join(fixtureDir.root, 'nested', 'project', '.board')
  const team = join(fixtureDir.root, 'team')
  return [
    ['daemon', 'com.example.cloudflared-old', 'binary plist'],
    ['daemon', 'com.example.tunnel', '/usr/bin/cloudflared'],
    ['daemon', 'org.example.politburo.board-party', '/opt/node --token <redacted> /opt/politburo/packages/board/dist/cli.mjs serve /etc/politburo/board-party.env'],
    ['agent', 'com.cloudflare.cloudflared', '/usr/local/bin/cloudflared tunnel'],
    ['port', '127.0.0.1:4101', 'pid 42  /opt/node --token <redacted> serve'],
    ['port', '[::1]:4102', 'pid 42  /opt/node --token <redacted> serve'],
    ['port', '127.0.0.1:4103', 'pid 15  /usr/local/bin/node --token <redacted> serve'],
    ['port', '127.0.0.1:7844', 'pid 9  /usr/bin/cloudflared tunnel'],
    ['board', board, 'party.db'],
    ['board', team, 'local.db'],
    ['skipped', join(fixtureDir.root, 'locked'), 'cannot read'],
  ]
}

test('host status lists launch jobs, listeners, and board directories', (t) => {
  const made = fixture(t)
  const args = ['host', 'status', '--root', made.root, '--launchd', made.daemons, '--launchd', made.agents, '--proc', made.proc]
  const text = run(args)
  const json = run([...args, '--json'])
  assert.equal(text.status, 0, text.stderr)
  assert.equal(json.status, 0, json.stderr)
  assert.equal(text.stderr, '')
  assert.equal(json.stderr, '')
  const rows = rowsOf(made)
  assert.equal(text.stdout, table([['kind', 'name', 'detail'], ...rows]))
  assert.deepEqual(JSON.parse(json.stdout), { rows: rows.map(([kind, name, detail]) => ({ kind, name, detail })) })
  assert.equal(text.stdout.includes(envSecret), false)
  assert.equal(text.stdout.includes(flagSecret), false)
  assert.equal(text.stdout.includes(quietSecret), false)
  assert.equal(json.stdout.includes(envSecret), false)
  assert.equal(json.stdout.includes(flagSecret), false)
  assert.equal(json.stdout.includes(quietSecret), false)
})

test('host status keeps the host process table when --proc is omitted', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-host-live-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const server = createServer()
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected a TCP port')
  const result = run(['host', 'status', '--root', dir, '--launchd', dir, '--json'])
  assert.equal(result.status, 0, result.stderr)
  const rows = JSON.parse(result.stdout).rows as { kind: string; name: string; detail: string }[]
  const found = rows.find((row) => row.kind === 'port' && row.name === `127.0.0.1:${address.port}`)
  assert.ok(found)
  assert.match(found.detail, /^pid \d+  /)
  assert.match(found.detail, /\bnode\b/)
})

test('host status rejects a missing root and an unknown command', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-host-miss-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const missing = run(['host', 'status', '--root', join(dir, 'absent'), '--launchd', dir, '--proc', dir])
  assert.equal(missing.status, 1)
  assert.equal(missing.stderr, `error: cannot read ${join(dir, 'absent')}\n`)
  const bare = run(['host'])
  assert.equal(bare.status, 2)
  assert.match(bare.stderr, /^error: missing host command\nusage: swarm host status /)
  const flags = run(['host', 'status', '--json'])
  assert.equal(flags.status, 2)
  assert.match(flags.stderr, /^error: missing --root\nusage: swarm host status /)
})
