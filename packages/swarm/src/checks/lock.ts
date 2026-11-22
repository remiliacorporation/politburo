import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const script = 'sysopen(my $f, $ARGV[0], O_WRONLY|O_CREAT|O_APPEND|O_NOFOLLOW|O_NONBLOCK) or exit 3; flock($f, LOCK_EX|LOCK_NB) or exit 75; print "held\n"; $|=1; <STDIN>; exit 0'

export class LockError extends Error {}
export type LockResult = { ok: true; release(): Promise<void> } | { ok: false; reason: 'busy' }

export function lockFile(path: string) {
  if (!path) throw new LockError('missing check lock path')
  const file = resolve(path)
  if (/\.(?:owner|json)$/.test(file)) throw new LockError('check lock path cannot end in .owner or .json')
  return file
}

export function tryAcquire(path: string, start = spawn): Promise<LockResult> {
  const helper = start('perl', ['-MFcntl=:flock,:DEFAULT', '-e', script, lockFile(path)], {
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const input = helper.stdin!
  const output = helper.stdout!
  input.on('error', () => {}) // The helper may die before release closes the pipe.
  const closed = new Promise<void>((done) => helper.once('close', () => done()))
  return new Promise((done, reject) => {
    let reply = ''
    output.setEncoding('utf8').on('data', (chunk: string) => {
      reply += chunk
      if (reply === 'held\n') done({ ok: true, async release() { input.end(); await closed } })
    })
    helper.once('error', (error: NodeJS.ErrnoException) => {
      reject(new LockError(error.code === 'ENOENT' ? 'perl is required for the check lock' : 'cannot start check lock helper'))
    })
    helper.once('close', (code) => {
      if (code === 75) done({ ok: false, reason: 'busy' })
      else reject(new LockError(code === 3 ? 'cannot open check lock file' : 'check lock helper did not acquire the lock'))
    })
  })
}

export async function acquire(path: string, { waitMs, pollMs }: { waitMs: number; pollMs: number },
  { attempt = tryAcquire, now = () => performance.now(), pause = sleep } = {},
): Promise<LockResult> {
  const end = now() + waitMs
  let result = await attempt(path)
  while (!result.ok && now() < end) {
    await pause(Math.min(Math.max(1, pollMs), Math.max(0, end - now())))
    if (now() >= end) break
    result = await attempt(path)
  }
  return result
}

export async function lockState(path: string): Promise<'held' | 'free'> {
  const lock = await tryAcquire(path)
  if (!lock.ok) return 'held'
  await lock.release()
  return 'free'
}
