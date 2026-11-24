status: proposed

# Deterministic simulation testing

## Status

Proposed. The harness is not in the test suite on `main`.
[SPEC.md: Tasks](../SPEC.md#tasks) describes what board does today.

| Section | Status |
| --- | --- |
| Simulation and oracles | Not built. An earlier prototype was throwaway test code. |
| Append-time guard and work evidence | Held in [#20](https://github.com/remiliacorporation/politburo/pull/20), not on `main`. This includes `store/append-guard.ts` and `task.work_*` events. |
| Staged work and access fence | Held in [#21](https://github.com/remiliacorporation/politburo/pull/21), not on `main`. This includes `store/fence.ts`, `task.stage_changed`, and the proof-aware CLI claim drop. |

## Problem

A local board checks a task and then appends events. The board log's head
can stay put while the clock passes a lease deadline or a grant changes in
the separate access log. Ordinary concurrent tests leave those orderings to
promise and timer timing. A failure may not repeat on the next run.

## Proposal

Deterministic simulation testing (DST) runs real board requests against a
local engine. A seed chooses operations, when they cross I/O boundaries,
when time advances, and where a client stops. Check the resulting history
against the task contract. Replay the choices without relying on how fast a
promise resolves. This supplements conformance and real I/O tests.

### Seams

- **Wall clock.** Task leases use `Date.now()` in
  [`server/tasks.ts`](../packages/board/src/server/tasks.ts). So do credential
  checks in [`server/policy.ts`](../packages/board/src/server/policy.ts).
  [`memory({ clock })`](../packages/board/src/store/memory.ts) takes a log
  clock. Use the same virtual time for both sources.
- **Timers.** [`scheduler/local.ts`](../packages/board/src/scheduler/local.ts)
  runs delayed work on process timers. Start without it, as
  [`testBoard()`](../packages/board/test/harness.ts) does by default. There
  are no `lease.due` timers, but requests still check for expiry. Leave
  retry timers real. Do not generate polling waits in the spike.
- **Randomness.** Claim tokens and opaque IDs stay random. In
  [`server/writes.ts`](../packages/board/src/server/writes.ts), retry jitter
  changes when an operation reaches its gate. The driver waits for every
  runnable operation, so arrival order does not choose who goes first.
  Normalize IDs and omit secrets. Byte-for-byte replay needs test ID and
  token sources, including ID options passed through both store adapters.
- **Check to append.** `appendFrom` in `server/writes.ts` runs `look` before
  `appendIfLast`. `whileHeadMoves` retries on a changed head. `untilApplied`
  catches the tables up after a write. In `server/tasks.ts` both `change`
  and the lease timer's `due` decide before appending. Wrap `store.log.append`
  on the injected [`BoardStore`](../packages/board/src/store/types.ts). No
  product change is needed for that gate. On #20, the append guard checks in
  the store's clock hook inside the append. Keep the gate outside that check.
- **Cross-session access.** [`server/trust.ts`](../packages/board/src/server/trust.ts)
  stores grants in a separate log session. `ifLastIndex` protects only the
  session it appends to. A board append can still see the same board head
  after the grant snapshot changes. On #21, the fence serializes access
  writes with staged writes and rechecks the access head. Wrap
  `store.fence.access` and `store.fence.guarded` to track lock waiters.
- **SQLite.** The memory store uses an A2 memory log and in-memory SQLite
  tables. [`store/sqlite-db.ts`](../packages/board/src/store/sqlite-db.ts)
  runs table transactions synchronously. The file-backed log uses a separate
  adapter, and [`sqlite()`](../packages/board/src/store/sqlite.ts) does not
  take a test clock on `main`.
- **Blob files.** [`server/blob.ts`](../packages/board/src/server/blob.ts)
  writes the bytes and their `.type` sidecar separately. Use `memoryBlob()`
  by default. A `BlobStore` wrapper can inject failures at its boundary. A
  crash between the two file writes needs a finer seam.
- **CLI claim files.** [`cli/claims.ts`](../packages/board/src/cli/claims.ts)
  writes a temporary file and renames it. On `main`, `drop` unlinks the
  claim. `memoryClaims` and `tokenClaims` do not exercise that file behavior.
  Use an isolated `XDG_CONFIG_HOME` and gate filesystem calls. The prototype
  mocks `node:fs/promises`; an optional `fs` argument to `fileClaims` gives
  the suite a narrower seam.
- **Process state.** [`server/identity.ts`](../packages/board/src/server/identity.ts)
  caches linked-project discovery based on the working directory.
  [`client/node.ts`](../packages/board/src/client/node.ts) and
  [`server/index.ts`](../packages/board/src/server/index.ts) read the
  environment. Inject project identity and credentials. Isolate any changes
  to the working directory, environment, and module caches between seeds.
- **Network.** Inject `fetch` through
  [`server/backend-http.ts`](../packages/board/src/server/backend-http.ts)
  or [`client/client.ts`](../packages/board/src/client/client.ts).
  [`server/tokens.ts`](../packages/board/src/server/tokens.ts) otherwise
  uses network discovery for keys. Inject test JWKS and keep real `jose`
  verification. Wait for crypto to reach a gate or finish.

### Harness

Mount a fresh engine per seed with `memory()`, `memoryBlob()`, and a test
issuer. Use distinct verified callers for access checks. Run without sync
or watchers. Send requests to the board handler in-process or use the
handle. Only the environment adapters are wrapped. The memory log's head
check and insert run in one synchronous step. The driver controls the
awaits around that step.

1. Seed `mulberry32` for driver choices. Assign each operation an index at
   creation. Carry it in `AsyncLocalStorage`. Park each operation at a start
   gate, then at each call to the wrapped `store.log.append`.
2. Wait until every operation is parked, blocked on a known lock, or done.
   Sort parked operations by index. Pick one with the RNG. Optionally move
   the clock, then release that operation to run to its next boundary.
   Count each append retry as a new gate visit.
3. Mark operations waiting to acquire the access fence as blocked, not
   runnable. Mark them running again when the lock callback begins. This
   lets the driver release a lock holder parked at append. If a wait is
   unaccounted for, a real-time watchdog reports a stall with the trace.
4. Start at a fixed instant. Fake only `Date` with
   `vi.useFakeTimers({ toFake: ['Date'] })`. Feed `memory()` that same time.
   At an append gate, with probability 0.6 choose a live lease from the
   recorded history. Jump to its `until` plus one of `-1`, `0`, `+1`, or
   `+1000` ms. Skip targets earlier than the current time. Use test
   credentials that stay live across jumps.
5. At wrapped filesystem boundaries, the driver can kill a logical CLI
   process. The operation never resumes and counts as done. Do not throw
   through its cleanup handlers. Keep side effects already made. Start a
   fresh client on the same files for the recovery read.

For each run, record the fixture, seed, gate choices, clock moves, and faults.
Record only landed events, with their append times and batch boundaries.
Use the order of successful append steps to merge board and access history.
Do not compare indices from different sessions or order writes by responses.
Save normalized histories and request outcomes for replay. Compare two runs
of a pinned seed in the spike. A replay mismatch is a harness failure.

### Generators

Start with small fixtures and named races. Vary the actors and the order of
claim, renew, release, takeover, assign, needs, cancel, revoke, and reopen.
Use submit, scope, and stage moves only on the held branches that have them.
Do not generate pause, resume, or timer-driven expiry in the first suite.

Use `fast-check` as a test-only dependency, added in the suite phase, for sequential generation and
shrinking. Give the generator macro operations such as finishing a task.
A macro makes a reachable state common without making its calls atomic.
Re-run each shrunk operation list with the same scheduler seed. Keep the
minimized list, seeds, shrink path, and gate trace for failures.

## Tests

### History oracles

Oracles take only the fixture and recorded history. They never consult
product code, reducers, or tables. Keep a small independent model of leases,
grants, and needs from landed events. Check state after each atomic append
batch. For claim files, use operation outcomes and a fresh `get` observation.

- **I1. Live lease.** `task.renewed`, `task.released`, `task.completed`, and
  #20's `task.work_submitted` must name the current lease epoch and land
  strictly before its `until`. Submission carries `round`, not `epoch`.
  Use the append time and the prior lease deadline, not a renewal's new one.
- **I2. One claim.** `task.claimed` cannot land while another lease for that
  task is live. Test the old lease at append time, even if the same batch
  records `task.expired`. At `until` the old lease no longer holds the task.
- **I3. Revoked scoper.** No staged task event from the scoper lands after
  `grant.deleted` removes its authority. Use a fixture with no other grant
  that allows the action and no regrant. `grant.revoked` is not the event
  for this operation. This is a #21 staged-write rule, not a claim about all
  legacy writes.
- **I4. Ready means satisfied.** A `ready` task has no unfinished
  prerequisite. Track needs replacements, completion, and reopen. A #21
  reopen of done work makes it unfinished again. This does not require every
  task with satisfied needs to be ready, or invalidate a dependent's live
  claim on reopen.
- **I5. A stale drop cannot lose a saved claim.** After a successful put, a
  drop for an older proof cannot make the new claim disappear. Read with a
  fresh client once surviving calls settle. Exclude a matching drop,
  another put, or legitimate pruning from the fixture.

Two checks remain outside the prototype. A reader learns nothing about
facts hidden by grants. Compare its responses in paired runs that differ
only in hidden facts. Evidence-gated completion does not spend an expired
verdict. That check needs #20's evidence events and append time, as in I1.

### Seed shapes

- **(a) Lease boundary.** Race renew, submit, and release with a takeover
  claim. Move the clock across `until` at the append gate. Submit is #20
  only. E1 exercises I1; the same history checks I2.
- **(b) Verdict boundary.** Try evidence-gated completion with a live lease.
  Move time to a passing verdict's `expiresAt` at the append gate. No
  completion lands. This is #20 only.
- **(c) Access change.** Interleave a scoper's access read and staged write
  with revocation of the fixture grant. Check the merged history for I3.
  Use stage, assignment, and needs changes on #21. This is E2.
- **(d) Claim cache race.** Race a stale drop with a new put for the same
  claim key. Kill at a filesystem boundary and read from a fresh client.
  This is E4 and checks I5.
- **(e) Reopened prerequisite.** Finish a prerequisite via a multi-step
  macro and let its dependent reach `ready`. Reopen that prerequisite.
  This is E3 and checks I4. Reopening a completed staged task is #21 only.
- **(f) Evidence POST redirect.** Return a redirect from a synthetic board
  during evidence completion. The client refuses it and sends no second
  write. The injected transport must respect fetch redirect modes. This is
  a #20 case. The prototype did not run this seed shape.

### Measured results

An earlier prototype measured these counts on throwaway code against the listed
revisions of the held PRs. They are not CI results. The spike PR re-measures
these comparisons before using them as regression evidence.

| Run | Pre-fix failing seeds | Fixed head failing seeds | Time at fixed head |
| --- | --- | --- | --- |
| E1 (a), #20 | 84/300 at `5b9c35e` | 0/300 at `e8fe0f6` | 24 s |
| E2 (c), #21 | 133/300 at `30b550a` | 0/300 at `fd0685f` | 31 s |
| E3 (e), #21 | 35/200 at `329fa78` | 0/200 at `fd0685f` | 16 s |
| E4 (d), #21 | 35/200 at `329fa78` | 5/200 at `fd0685f` | 4.6 s |

E1 produced 139 distinct traces. Its trace hashes matched across two runs.
For E3, single-move generators found 0 failures in 1,500 seeds. The finish
macro reached the failing state. The prototype also counted 46/46 failures
before the fix and 46/46 passes at head for #20's scripted atomicity suite.
That is not a seeded result for (b).

E4 still fails with a 12% kill chance per filesystem call. On #21, the new
put completes. A stale drop moves the saved claim to a tombstone, and the
process dies before restoring it. A fresh `get` returns nothing. Pruning
deletes old tombstones. It does not restore them.

## Limits

- **SQLite transactions.** An append gate does not interleave statements
  inside a synchronous transaction. The prototype does not control or
  verify the SQLite log adapter's conditional transaction.
- **A2 internals.** Drains, lapse timers, and internal retry jitter stay real.
  The driver waits for observed quiescence. It does not model A2 execution.
- **Multiple processes.** #21's access fence is in-process and per store.
  Killing a logical CLI actor does not test concurrent board processes, OS
  crashes, or disk durability.
- **External I/O.** Sync providers and the real network stack stay out of
  the simulator. Scripted `fetch` does not test sockets or transport timing.
- **Missing faults.** Lost acks after commit and partial writes need new
  wrappers. So do delayed access-log writes, lost responses, the blob
  sidecar gap, HTTP 5xx responses, and duplicate delivery.

## Alternatives

- Fake timers alone cannot choose which write crosses an append boundary.
- Antithesis: rejected because it is a paid service.

## Slices

1. **Spike.** Add the driver, append and fence wrappers, and E1/E2. Run a
   replay check and competing claims on `main` under `pnpm test`. Re-measure
   E1 to E4 against the pre-fix and fixed snapshots above. Use standalone
   drivers for E3 and E4 until the suite adds them. Pin seeds that fail
   before a fix and pass after it. Budget 100 to 200 seeds per implemented
   race in the default suite. Keep held or unresolved cases out of CI.
2. **Suite.** Add E3/E4, the sequential generator with macros and shrinking,
   and deterministic redirect handling for (f). Add hidden-read and verdict
   expiry checks. Run an append-boundary variant on file-backed SQLite, not
   an interleaving test inside transactions. Triage the E4 kill window on #21.
3. **Nightly.** Run thousands of seeds on a dedicated runner. Keep a fixed
   corpus and sample fresh seeds. Save failing traces for replay and shrink
   them before promoting regressions to the default suite.

## Reusable parts

A separate swarm stack can reuse the driver pattern, not board's storage or
policy. It supplies its own boundaries and contracts.

- Gate runnable operations and track lock waiters.
- Check independent oracles over recorded histories.
- Bias the virtual clock toward lease and timeout boundaries.
- Kill at named I/O points and check restart with prior side effects intact.
- Generate macro operations that reach states single moves rarely reach.
