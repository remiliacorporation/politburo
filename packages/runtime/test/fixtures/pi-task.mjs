#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const [file, maxSeconds] = process.argv.slice(2)
const task = readFileSync(file, 'utf8')
if (task === 'success') {
  console.log('ready')
  setTimeout(() => console.log('finished'), 40)
} else if (task === 'hang') {
  console.log('ready')
  setInterval(() => {}, 60_000)
} else if (task === 'fallback') {
  console.log(JSON.stringify({ model: process.env.PI_MODEL, maxSeconds, task, explicit: process.env.RUNTIME_TEST_OPT_IN, ambient: Object.hasOwn(process.env, 'RUNTIME_TEST_SECRET') }))
  if (process.env.PI_MODEL !== 'codex-cursor') process.exitCode = 42
} else if (task === 'pulses') {
  let pulses = 0
  const timer = setInterval(() => {
    console.error('pulse')
    if (++pulses === 4) clearInterval(timer)
  }, 75)
} else {
  throw new Error('unexpected fixture task')
}
