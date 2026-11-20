# @remilia/politburo-runtime

A private Node 22.18+ workspace package for running one explicitly selected
board task. The runner claims it, renews its lease, and returns the harness
result after releasing it. It never completes or fails the board task. If it
can't prove the lease is still live, it requests cancellation and returns
`lease_lost` without settling the task or reporting a late result.

```ts
import { createHash } from 'node:crypto'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { pi, runTask } from '@remilia/politburo-runtime'

const team = board({ backend: local({ memory: true }) })
const brief = 'Summarize this fixture.'
const { task } = await team.tasks.create('fixtures', brief)
const outcome = await runTask({
  board: team, taskId: task.id, provider: 'pi',
  harness: pi({ readBrief: () => brief, idleMs: 30_000, models: ['codex-cursor'] }),
  work: {
    repo: 'acme/web', baseSha: '0'.repeat(40), briefRef: task.id,
    briefSha256: createHash('sha256').update(brief).digest('hex'),
    allowedPaths: [], limits: { wallMs: 60_000, maxCostMicros: 0 }, requiredCheckIds: [],
  },
})
```

- `fake()` is in memory. `subprocess({ command, args })` runs a fixed command
  with stdin and stdout/stderr. `pi()` verifies the brief digest and writes a
  private task file; it defaults to `pi-task <task-file> [max-seconds]` with the
  selected model in `PI_MODEL`. Use `args` for wrappers that select models by
  flags. It retries eligible failures with the next model, within one wall
  deadline, and has no live stdin.
- The process adapters require POSIX and use a temporary working directory,
  a scrubbed environment, and process-group termination. Pi takes an explicit
  `env` object if the command needs it. Only run trusted commands: a process
  group and temporary home are not a sandbox. Output is returned verbatim to
  the caller, not logged; commands must not print secrets.
- Replay and output cursors last for the adapter instance. Output is paged but
  retained in memory; use this slice for bounded fixtures. Cancel requests
  stop; collect confirms it. There is no checkout, cost enforcement, artifact
  validation, or task settlement. `@remilia/politburo-runtime/conformance`
  exports the shared Node test suite for adapters.

## ops

`refill` drafts up to 15 proposed tasks when the ready queue runs low. `scanDiff` and `preflight` refuse added lines with tokens, keys, or emails. `createInstance` writes a self-hosted instance directory with no credentials. `writeResumePacket` and `appendAttempt` keep resume packets and an attempt ledger as plain files.

## Dispatch policies

```ts
import { capacity, localUsage, usageGuard } from '@remilia/politburo-runtime'

const guard = usageGuard(localUsage({ file: '/var/run/politburo/usage.json' }))
const pool = capacity({
  limits: { worker: 4, build: 2, qa: 2, review: 1 },
  heavy: { directory: '/var/run/politburo/slots', slots: 2 },
})
// Pass usageGuard: guard and capacity: { policy: pool, kind: 'build', heavy: true }
// to runTask alongside the normal runner options.
```

Both policies are optional and run before a board claim. The usage guard reads
`{ "usedFraction": 0.95, "resetAt": 1767243600000 }` for the five-hour window;
`resetAt` is Unix time in milliseconds. It returns `usage_blocked` at 95% or
more until that time. An expired snapshot doesn't block the new window. A read
or parse error rejects dispatch. Use a custom `UsageSource` or pass
`{ command, args }` to `localUsage` to read JSON from a trusted local command's
stdout. The adapter passes `PATH` and `HOME`, uses no shell, and calls no API.

Share one capacity policy instance for per-kind limits. The default run kind is
`worker`. Mark heavy work explicitly with `heavy: true`. For machine-wide
heavy slots, configure all processes with the same trusted local directory and
slot count. A full pool returns `capacity_unavailable` without waiting. If a
process is killed before cleanup, remove any stranded slot directory only after
confirming its run is no longer active.

The runner releases capacity on every outcome, including errors and lease loss.
If the lease is lost during start, a runner with a reservation waits for start
to reject or to return a ref it can cancel before it frees the reservation.
