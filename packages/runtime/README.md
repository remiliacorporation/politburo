# @remilia/politburo-runtime

A private Node 22.18+ workspace package for running one explicitly selected
board task. The runner claims it, renews its lease, and returns the harness
result after releasing it. It never completes or fails the board task. If it
can't prove the lease is still live, it requests cancellation and returns
`lease_lost` without settling the task or reporting a late result.

Pass `taskId` to run a specific task or `selection: { channel }` to let the
board claim the highest priority eligible task, oldest first at equal
priority. A board pause returns `paused` instead of starting work. On a
board that issues a `pauseEpoch` with the claim, the runner checks it before
calling the harness and polls board status at `pollMs` while running. A
pause or epoch change cancels the attempt through the harness and returns
`paused` with its task ID. If a start is still unanswered, the runner
cancels it when the ref arrives. Cancellation requests stop; it does not
confirm termination. After resume call `runTask` again to get a fresh claim.

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

## Routed attempts

`createRouter` takes a server-owned executor and a list of provider/model pairs
with per-attempt token cost caps in micros. It reads `boardScoreboard` once per
call and ranks by `quality`, `cost`, or `latency`. Specify the task's budget,
paths, base commit, and required checks in `work`; the router freezes that
contract across retries. The router returns a verified candidate or a stopped
reason. It does not change the task state or own its claim.

```ts
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { boardScoreboard, createRouter, registerScoreboardSchema } from '@remilia/politburo-runtime'

const team = board({ backend: local({ memory: true }) })
const writer = team.as('router')
await registerScoreboardSchema(team) // setup with schema-registration permission
const scoreboard = boardScoreboard({ board: writer, channel: 'runtime/scoreboard', author: (await writer.me()).actor })
const route = createRouter({
  scoreboard,
  models: [{ provider: 'fixture', model: 'small', maxCostMicros: 10 }],
  maxAttempts: 2,
  cooldownMs: { quota: 30_000, auth: 60_000, timeout: 5_000 },
  probeTimeoutMs: 1_000,
  execute: async () => ({ outcome: 'bad-output', costMicros: 0 }), // fake, no provider call
})
const outcome = await route({
  taskId: 'fixture-task', mode: 'quality',
  work: {
    repo: 'acme/web', baseSha: '1'.repeat(40), briefRef: 'fixture-brief', briefSha256: '2'.repeat(64),
    allowedPaths: ['src/', 'README.md'], requiredCheckIds: ['test'],
    limits: { wallMs: 30_000, maxCostMicros: 20 },
  },
})
console.log(outcome.status, await scoreboard.read())
```

Use a dedicated scoreboard channel and restrict its writers. Attempt samples
are ordinary, unsynced board blocks, attributed by the board. Reads ignore
other actors and use the latest 100 messages by default. The same writer can
replay an attempt ID without double counting it.

The executor owns cancellation, in-flight cost enforcement, and evidence from
an actual checkout and verifier. A returned result must mean the run stopped.
On `execution-uncertain` or a board write error, reconcile the previous run
before calling again. Use a caller-held lease around routing; the existing
`runTask` helper is not a routed executor and its fixture adapters do not meter
tokens or produce verification evidence. The budget covers one call and its
retries. Cooldowns and access incidents are in memory. An auth incident gets
one access probe after cooldown, if configured; only a successful probe clears
it. A failed probe leaves the provider unavailable in that router instance.

## Benchmarks

`bench-run@1` blocks hold counts, identifiers, ratings, and times in the
unsynced `bench` channel. The first write for a run ID wins. Use the same
trusted board actor for ingest and report; the report ignores other writers
and counts sprites, not roll-ups. The first ingest needs permission to
register the schema. A replay succeeds only if the stored message is a live
benchmark root in the same channel by the same actor.

Run IDs are limited to 150 characters and serialized blocks to 9,000. Outcome
reasons are short codes (up to 80 characters, no slashes); check commands are
names of one or two words without options (up to 60 characters). Wall time
must agree with the timestamps within one millisecond; known active time
cannot exceed wall time. `none` token coverage means all four counts are null;
`complete` means all four are known. `partial` allows either.

With `BOARD_URL` set, run from the repository root:

```sh
node packages/runtime/src/bench/cli.ts ingest runs.jsonl
node packages/runtime/src/bench/cli.ts report
node packages/runtime/src/bench/cli.ts report --json
```

Text columns are model, thinking, rating, runs/checked, pass rate, median
wall seconds, median tokens, p90 tokens, and tokens per changed line. A dash
means unknown. Tokens per changed line uses only runs with known input and
output token counts and at least one changed line. Text lists run IDs below
each row; `--ids` is still accepted but does not change the report. JSON
includes full names, run IDs, and token coverage counts.

## Remote work

`localGit({ repoDir, identity })` exchanges UTF-8 text files (up to 64 KiB)
under `remote/<agent>/brief`, `control`, `inbox`, and `status`. Use a Git
repo root and keep exchange branches out of the worktree. Read returns the
file and the head it came from. Pass that head to `write`, or `null` to
create a branch with an empty tree. A stale write throws `RefConflict`;
read again before retrying. The store never fetches or pushes. Sync with
ordinary fast-forward Git pushes and fetches. Use `refs/heads/<branch>` on
both sides of the refspec; remote-tracking refs are not read by the store.

```ts
import { ghCodeHost, localGit, reviewGate, watchRemote } from '@remilia/politburo-runtime'
import type { GhOptions, Verdict } from '@remilia/politburo-runtime'

async function pollWork(repoDir: string, token: string, key: Uint8Array,
    verdicts: readonly Verdict[], withHeadLock: GhOptions['withHeadLock']) {
  const refs = localGit({ repoDir, identity: { name: 'Worker', email: 'worker@example.test' } })
  const host = ghCodeHost({ repo: 'acme/web', base: 'main', requiredCheckNames: ['ci'], token, withHeadLock })
  const watcher = watchRemote({ refs, host })
  const result = await watcher.poll({
    statusBranch: 'remote/worker/status', branch: 'work/worker', title: 'Finish worker task',
  })
  if (result.status === 'checked') {
    const gate = reviewGate({ host, key, checkFor: watcher.checkFor, verdictsFor: () => verdicts })
    return gate.markReadyIfAllowed(result.pr)
  }
  return result
}
```

- The worker writes `{"state":"finished"}` to `status.json` after publishing
  its work branch. A missing file or `{"state":"working"}` does nothing.
  Keep one watcher owner per work branch. Polls reuse the existing PR even
  if it has closed. Check results are held by SHA in the watcher instance.
- The GitHub adapter uses `gh` with a caller-supplied token or `exec`. It
  reads the named GitHub check runs for the exact commit; configure CI to
  run on PRs or pushes. It does not dispatch workflows.
- Reviewers call `signVerdict({ sha, reviewer, outcome }, key)`. Pass a
  shared secret from the caller, not from the exchange files. The gate
  returns a typed refusal unless there is a pass and a valid clean verdict
  on the current SHA. A later push needs its own check and review. The gate
  does not convert an already-ready PR back to draft.
- GitHub has no atomic compare-head-and-mark-ready operation. The adapter
  refuses with `readiness_unfenced` unless `withHeadLock` excludes **all**
  head updates through the transition. A local mutex does not fence pushes
  on GitHub. Use a host-enforced immutable head or a coordinated write path
  that can also keep the head fenced if the mutation outcome is uncertain.

## Controller loop

`runController()` follows the event long-poll on a board handle bound to the
agent's inbox principal. It reads `operationalInbox` after each feed page,
including empty pages: the generic feed does not expose private inbox mail.
Feed requests are serial and start at least one configured long-poll interval
apart, even when a page returns early.

Pass the agent's inbox address, roles, a `parentOf(agent)` adapter, a monotonic
clock, and an abort signal. The registry adapter maps the inbox identity to the
registration and returns the immediate parent's inbox address or `null`.
The loop records `seen` before calling `wake`. Return `'acted'` only after the
work is done. Returning nothing or throwing leaves the message eligible for
escalation. The board authors receipts and escalation provenance.

The deadline starts when the loop first observes an unacted message, even if
the handler is still running. At the deadline the loop checks the inbox once
more. It sends one reference to the immediate parent only if the message is
still visible and unacted. It does not forward private message text. The check
and send are separate board calls, not an atomic operation. Wake and escalation
deduplication are local to the invocation. The loop does not persist checkpoints
or coordinate multiple instances.

## Stall watcher and heartbeat

`nextBeat()` returns the next slot strictly after the given epoch time in
milliseconds. `heartbeat()` uses that grid until abort. Give agents different
offsets to spread their beats. Offsets wrap at the period. A failed beat
rejects and stops the loop, including a 409 for a stale or disabled agent.

```ts
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { heartbeat, stallWatcher } from '@remilia/politburo-runtime'

const backend = local({ memory: true, agentOps: true })
const team = board({ backend })
const channel = 'work'
const agent = await team.agents.register({ channel, role: 'implementation-worker', harness: 'pi' })
const to = { agent: (await team.me()).principal }
const watcher = stallWatcher(team, { channel, to, now: Date.now })
const stop = new AbortController()

try {
  const [result] = await Promise.all([
    watcher.check().finally(() => stop.abort()), // Stop after one check in this example.
    heartbeat(team, agent, { everyMinutes: 30, offsetMinutes: 5, now: Date.now, signal: stop.signal }),
  ])
  const missedCount = result.kind === 'quiet' ? result.missed?.length ?? 0
    : result.kind === 'missed' ? result.agents.length : 0
  const errors = 'errors' in result ? result.errors ?? [] : []
  console.log({ kind: result.kind, missedCount, failedCount: errors.length, failedTopics: errors.map(({ topic }) => topic) })
} finally {
  stop.abort()
  await backend.close()
}
```

Await each `check()` in your loop. It reads the last 25 board feed events on
its first check, follows the feed cursor after that, and reads the agent
registry for `channel`. Use a `now()` that follows the board's wall clock
in epoch milliseconds. After `quietMinutes` with no activity (30 by default),
it returns `quiet`. `sinceMs` starts at watcher creation and tracks the
latest board-authored event or enabled agent heartbeat seen. Unparseable
event timestamps are ignored, and future events count only up to `now()`.
Clearing a heartbeat does not erase its activity.

An enabled agent is `missed` when its heartbeat is older than twice
`periodMinutes` (30 by default). Without a heartbeat, age starts at watcher
creation for agents seen on the first check, or at the check that first
sees the agent otherwise. A generation change restarts that grace. Pass a
function for per-agent periods. Return `undefined` to skip that agent's
missed check. An active feed does not suppress missed alerts. A `quiet`
result includes `missed` if there are also late agents.

The watcher sends one inbox message per topic (`stall:quiet:<channel>` or
`stall:missed:<channel>:<agentId>`) until a check sees that issue recover.
It escapes control and format characters in channel names, agent IDs, and roles,
and shortens long values with a stable hash suffix.

A check can send several topics. It reads pause status at the start and just
before each send. If paused, it returns `paused` and sends no further messages.
The extra read narrows the race but is not atomic with the send. The result
reports failed sends in `errors` as `{ topic, error }` entries, even if a pause
stops the check. Error messages omit control and format characters and are at
most 256 UTF-16 code units. Unless paused, other sends in the same check still
go out. The next check retries failed topics that are still active.

The feed cursor and topic dedupe live only in memory for this watcher
instance. If a send succeeds but its response is lost, the next check can
retry it. The board's latest-send-replaces rule then supersedes the first
message and its receipt is lost. The watcher does not wake or stop agents
or change task state.

## ops

`refill` drafts up to 15 proposed tasks when the ready queue runs low. `scanDiff` and `preflight` refuse added lines with tokens, keys, or emails. `createInstance` writes a self-hosted instance directory with no credentials. `writeResumePacket` and `appendAttempt` keep resume packets and an attempt ledger as plain files.

See [Names](#names) for the shared name pool.

## Names

Every name Politburo needs comes from one pool, `namePool`, defined in one
module: spawners, agents, workers, boards, lanes, demo data, and codenames.
A name is a Soviet industry noun in Russian transliteration, 8 letters or
fewer.

`pickName(inUse)` returns the first pool name that is not in `inUse`. Pass the
names of everything alive that holds one. A freed name is taken again before
any later unused name. Duplicate names count once. It ignores strings that
aren't pool names and throws when all 33 names are in use. Each entry must be
a string without control or format characters. Don't write pool names as
literals elsewhere; import them.

A spawner is one use. Its title is `<TAG> <NAME>`, for example `RW ZAVOD`. It
takes the first unused name and keeps it. `pickName` only reads the names you
pass: two callers that read the same snapshot of live names get the same name,
so pick and reserve together, under one lock or in one atomic write.
`spawnerTitle` throws a `TypeError` for a non-string tag and a `RangeError`
for an empty tag, a tag containing whitespace, control or format characters,
or a name outside the pool.

```ts
import { pickName, spawnerTitle } from '@remilia/politburo-runtime'

const liveNames = ['FABRIKA']
const name = pickName(liveNames) // 'ZAVOD'
const title = spawnerTitle('RW', name) // 'RW ZAVOD'
```

| Group | Names and meanings in allocation order |
| --- | --- |
| Workplaces | `ZAVOD` (factory); `FABRIKA` (mill); `KOMBINAT` (industrial combine); `KOLKHOZ` (collective farm); `SOVKHOZ` (state farm); `ARTEL` (workers' cooperative); `SHAKHTA` (mine); `TSEKH` (workshop); `DOMNA` (blast furnace); `KOTLOVAN` (foundation pit) |
| Bosses and roles | `PRORAB` (site foreman); `BRIGADIR` (brigade leader); `MASTER` (shop foreman); `NARKOM` (people's commissar); `UDARNIK` (shock worker); `TREST` (industrial trust); `GLAVK` (chief directorate) |
| Planning | `GOSPLAN` (state planning committee); `NORMA` (production quota); `SMENA` (work shift); `OTDEL` (department) |
| Tools and machines | `MOLOT` (hammer); `SERP` (sickle); `TRAKTOR` (tractor); `TURBINA` (turbine); `KRAN` (crane); `STAL` (steel); `GUDOK` (factory whistle) |
| Famous plants | `MAGNITKA` (the Magnitogorsk steelworks); `URALMASH` (the Ural machine works); `ZIL` (Likhachov automobile plant); `GAZ` (Gorky automobile plant); `KAMAZ` (Kama automobile plant) |

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
