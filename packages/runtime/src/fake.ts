import { finish, ledger } from './ledger.ts'

/** An in-memory fixture: prints `ready`, echoes input, and exits on `finish\n`. */
export function fake() {
  return ledger((run, { work }) => {
    const end = () => clearTimeout(timer)
    const timer = setTimeout(() => finish(run, { outcome: 'failed', failure: 'timeout' }), work.limits.wallMs)
    run.stop = () => {
      if (run.state === 'stopping') return
      run.state = 'stopping'
      end()
      queueMicrotask(() => finish(run, { outcome: 'canceled' }))
    }
    queueMicrotask(() => {
      if (run.state !== 'starting') return
      run.state = 'running'
      run.events.push({ type: 'stdout', text: 'ready\n' })
    })
    run.input = (text) => {
      if (text === 'finish\n') {
        end()
        finish(run, { outcome: 'exited', exitCode: 0 })
      } else {
        run.events.push({ type: 'stdout', text })
      }
      return 'accepted'
    }
  }, true)
}
