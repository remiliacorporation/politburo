import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const [mode, audit] = process.argv.slice(2)
if (audit) {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(audit, 'started\n')
}

if (mode === 'environment') {
  console.log(JSON.stringify({ cwd: process.cwd(), home: process.env.HOME, ambient: Object.hasOwn(process.env, 'RUNTIME_TEST_SECRET') }))
} else if (mode === 'grandchild') {
  console.log(`grandchild ${process.pid}`)
  setInterval(() => {}, 60_000)
} else {
  if (mode === 'tree') spawn(process.execPath, [import.meta.filename, 'grandchild'], { stdio: ['ignore', 'inherit', 'inherit'] })
  console.log('ready')
  for await (const line of createInterface({ input: process.stdin })) {
    if (line === 'finish') break
    console.log(line)
  }
  process.stdin.destroy()
}
