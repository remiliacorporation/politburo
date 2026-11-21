status: proposed
bonklek decides on this PR.

## Status

The first slice and much of the follow-up shipped as the private package
`@remilia/politburo-runtime` in `packages/runtime`, starting with
[#8](https://github.com/remiliacorporation/politburo/pull/8). Its
[README](../packages/runtime/README.md) is the guide, and
[SPEC.md: Routed attempts](../SPEC.md#routed-attempts-politburo-runtime) covers
the router. The server-side managed work (task stages, gates, runtime routes)
is not built: lifecycle stages
([#21](https://github.com/remiliacorporation/politburo/pull/21)) and evidence
gates ([#20](https://github.com/remiliacorporation/politburo/pull/20)) are held.
[#14](https://github.com/remiliacorporation/politburo/pull/14) and
[#15](https://github.com/remiliacorporation/politburo/pull/15) are closed, and
their code reached `main` through the integration PR
[#26](https://github.com/remiliacorporation/politburo/pull/26).

| Section | Status |
| --- | --- |
| Problem | Implemented. `runTask` claims, renews and normally releases a task, and never completes or fails it. On lease loss it requests cancellation and drops the result. |
| Proposal: a separate package | Implemented in #8. `packages/runtime` uses the public `board` handle, and nothing in `packages/board` imports it. No managed lifecycle is added to the task contract. |
| Harness methods | Implemented in #8, as proposed. `HarnessKind`, `WorkSpec`, `Start`, `State`, `Observation`, `Result`, `Failure` and the five methods are in `src/harness.ts`. An observation's events are `stdout` and `stderr` text. |
| Contract table: identity, replay, state | Implemented in #8. A start ID replays within one adapter instance and a send ID within one run. A different payload is `ReplayConflict`. `@remilia/politburo-runtime/conformance` exports the shared suite. |
| Contract table: adapters | Partly implemented. `fake()`, `subprocess()` and `pi()` exist. `pi()` runs `pi-task` by default as a process, falls back to the next configured model on an eligible failure within one wall deadline, and has no live stdin. `codex-cli` and `claude-cloud` are in `HarnessKind` only, with no adapter. |
| Managed work: task creation, `claimManagedTask`, `moveManagedTask` | Not built (held, #20 and #21). There are no `/runtime` routes, no `proposed` stage and no `runtime_tasks` discovery flag. The runner uses `board.tasks.claim`. For a ready selection the board takes the highest priority task, then one assigned to the caller, then the oldest ([#11](https://github.com/remiliacorporation/politburo/pull/11)). |
| Managed work: routing | Implemented in [#16](https://github.com/remiliacorporation/politburo/pull/16), changed. `createRouter` ranks provider and model pairs by a board-kept scoreboard, retries by failure class with cooldowns, and reserves each attempt's cost cap. The host supplies the executor, the checkout evidence and cost enforcement, and the router checks the reported base, head, paths and checks against the frozen contract. The runner and the router are separate: `runTask` is not a routed executor. |
| Managed work: pause and capacity | Implemented, changed. `runTask` checks the claim's `pauseEpoch`, when the board issues one, ([#25](https://github.com/remiliacorporation/politburo/pull/25), [#13](https://github.com/remiliacorporation/politburo/pull/13)) and cancels on a pause. `usageGuard` blocks at 95% of the five-hour window until `resetAt` and `capacity` reserves per-kind and host-wide heavy slots (#15). Both policies are optional and run before the claim. Nothing wakes at the reset, and a slot is freed by `release`, not by expiry. |
| Managed work: remote work and review | Partly implemented in [#18](https://github.com/remiliacorporation/politburo/pull/18). `localGit` exchanges `brief`, `control`, `inbox` and `status` files on `remote/<agent>/` branches, `watchRemote` opens a draft PR, and `reviewGate` marks it ready only on a passing check set and a signed clean verdict for the current head. A verdict uses a shared-secret signature, and no control write checks a signer, generation or expiry. There is no merge. GitHub has no atomic head-and-ready operation, so the adapter refuses with `readiness_unfenced` without `withHeadLock`. |
| Reuse of swarm and factory | Not done. The package has its own process and checkout-free adapters. |
| Trust model | Not built as written. There are no managed roles or `/runtime` routes. The process adapters run trusted commands in a temporary directory with a scrubbed environment, and the README says they are not a sandbox. |
| Migration and compat | Not applicable so far. Existing tasks are unchanged, and the runner works with legacy claims. |
| Tests | Implemented for the first slice, in `packages/runtime/test` with `node:test`: shared adapter conformance against a fake, a real fixture process and `pi()`, the runner against a local board, and tests for the router, remote work, controller and policies. Not built: the managed follow-up checks. |
| Alternatives | (a) not applicable until managed work is built. (b) as proposed. (c) not adopted: SPEC.md keeps general board roles a non-goal. |
| Open questions | Partly answered. Usage comes from a caller-supplied `UsageSource` or a trusted command. GitHub has no mark-ready with a head precondition, so the adapter needs `withHeadLock`. |
| Slices 1 to 3 | Implemented in #8: the package and fake adapter conformance, the subprocess adapter, and `runTask`. |
| Beyond the design | Added: `runController` wakes handlers on inbox mail and escalates ([#23](https://github.com/remiliacorporation/politburo/pull/23)), and `ops` has refill, a privacy scan, an instance scaffold and resume packets and an attempt ledger (#14). |

## Problem

The existing [`Protocol`](../packages/board/src/api/protocol.ts) leases tasks
and settles claims. It does not supervise runs or require a reviewed commit.
On [`local()`](../packages/board/src/server/local.ts),
[`settle`](../packages/board/src/server/tasks.ts) can complete a task and ready
its dependents in one append.

## Proposal

Add a separate Node package at `packages/runtime` for the harness and the
fixture-only first slice. It uses board's public handle, not its tables or
A2. For later managed work, the server task contract owns lifecycle, gates,
and priority. Extend [`boardContract`](../packages/board/src/contract/contract.ts)
and check moves in the task server's conditional append. Labels are filters
or projections, never authority.

### Harness methods (proposed shapes, not SDK calls)

```text
HarnessKind = pi | codex-cli | claude-cloud | subprocess
WorkSpec = immutable { repo, baseSha, briefRef, briefSha256, allowedPaths[],
                       limits: { wallMs, maxCostMicros }, requiredCheckIds[] }
Start = { attemptId, taskId, claimEpoch, work: WorkSpec, provider, model? }
RunRef = opaque adapter handle (not a credential)
State = starting | running | stopping | exited | failed | canceled
Observation = { state: State, cursor, events[], usage: { costMicros } | null }
Result = { outcome: exited | failed | canceled, exitCode?, failure?,
           headSha?, artifacts: [{ ref, sha256 }], usage: { costMicros } | null }
Failure = transient | quota | provider_access | timeout | verification | lost

start(Start) -> RunRef
observe(RunRef, { after?, limit }) -> Observation
send(RunRef, { id, text }) -> accepted | unsupported | not_running
cancel(RunRef) -> void                      # requests stop, does not confirm it
collect(RunRef) -> Result | not_terminal
```

| Contract | Rule |
| --- | --- |
| Identity and replay | One attempt ID per routed try. Same start or send ID and payload does not repeat side effects within the adapter's supported lifetime. Different payload under the same ID conflicts. Reconcile an uncertain start before retrying. |
| State | `starting` → `running` → `exited` or `failed`; Cancel requests enter `stopping` until stop is confirmed, then `canceled` unless the run already ended. Terminal state and collected result stay fixed. An observation error is not an exit. Observations are bounded and resume from the opaque cursor. |
| Adapters | Pi maps session events, prompts and abort. Codex CLI maps process output and uses session input where supported. Claude cloud maps remote session status and control where supported. Subprocess maps output, stdin, process exit and process-tree stop. |

### Managed work boundaries (follow-up, not part of the first slice)

The first slice uses existing task methods and adds no HTTP routes. The
methods and routes below are proposed additions to `Protocol` and [`routes`](../packages/board/src/api/routes.ts).
The types they reuse are defined in `routes.ts`.

| Surface | Shape or invariant |
| --- | --- |
| Task creation | New tasks in server-configured channels start `proposed`, including single create, adoption, and batch. Reject create-and-claim there. Preserve [`batchPlan`](../packages/board/src/contract/task-batch.ts) validation, atomicity and retry semantics. |
| `claimManagedTask`, `POST /runtime/tasks/claim` | `ClaimReadyTaskInput` → `{ task: MessageView, claim: TaskClaim }` or `{ task: null }`. Use existing assignment and owner eligibility. Pick highest authorized priority (1 to 5, 5 highest), then oldest. Managed dispatch starts paused. No claim while paused or without resolved dependencies. |
| `moveManagedTask`, `POST /runtime/tasks/:id/move` | `{ ifVersion, op, ...opFields }` → `{ task: MessageView }`. `authorize` freezes `WorkSpec` at `proposed` → `ready`. `priority` sets the level. `renew` extends the lease; release or expiry returns the task to `ready` or `repair`, whichever it was claimed from. `submit` takes the claim proof, attempt ID and exact head SHA, moves `claimed` → `review`, and closes the lease. `verdict` moves `review` → `approved` on passing checks and a clean verdict for that head, or → `repair` on requested changes. `repair` can be claimed again and needs fresh evidence on resubmission. `finish` moves `approved` → `done` after the server checks the evidence. `resolveEdge` takes a prerequisite ID and accepted evidence; process exit does not resolve an edge. |
| Routing and capacity | Bind route (provider/model), controller and run to the immutable spec and claim epoch. Enforce the wall limit and validate base and changed paths before accepting a submission. Cancel on claim loss. Ignore late results. Retry by failure class after cooldown and within reserved cost; never mark work done. Stop dispatch at 95% of the provider account's five-hour window and wake to recheck at reset. Missing usage blocks paid dispatch. Reserve expiring worker, build, QA and review slots before launch, including host-wide slots for heavy checks. Do not reuse a slot until stop or enforced expiry. |
| Remote work and review | Carry briefs, control, inbox and status on scoped git refs for `acme/web`. Pin brief contents by commit and digest. Check signer, generation and expiry on control writes; refs do not grant authority. A runtime watcher opens a draft PR. It runs checks on the exact head and marks ready only on a passing required check set and a signed clean verdict from a separate reviewer for that head. A new head invalidates both. No merge. |

Reuse swarm's checkout and stop path in [`sandboxes.ts`](../templates/swarm/lib/sandboxes.ts)
and Pi session and lease handling in [`runner.ts`](../templates/swarm/sandbox/runner.ts).
Do not port its role or spend labels.

Reuse factory's thread-keyed wake with the event cursor as a delivery
idempotency key ([`wake.ts`](../templates/factory/agent/lib/wake.ts)) and repo
scoping ([`github.ts`](../templates/factory/lib/github.ts)). Its PR skills
do not enforce server gates.

## Trust model

[`createPolicy`](../packages/board/src/server/policy.ts) verifies the caller and
resolves [`Identity`](../packages/board/src/server/backend.ts).
[`grantAccess`](../packages/board/src/server/grants.ts) applies channel grants
and token narrowing. [`identity.ts`](../packages/board/src/server/identity.ts)
supplies project identity. Discovery is not caller proof.

Check the stored channel, not a channel from the request. Recheck current
access on dispatch and writes. Use [`accessNow`](../packages/board/src/server/policy.ts)
for stored principals and fail closed if it returns no access, including
for stored identities authenticated with a board token.

| Action | Required authority for managed work |
| --- | --- |
| Authorize, raise priority, finish, resolve an edge | Channel `manage`. Finish and edge resolution still need accepted evidence. |
| Claim, lower priority, renew, release, submit | Channel `label` and a controller role bound to the verified principal. Renew, release and submit also require the claim's bound principal and actor, live epoch and secret. |
| Record verdict | Channel `read`, reviewer role, separate principal from the submitter, and a trusted signature over task, attempt, head and verdict. Verify check provenance independently. |
| Run code | The controller keeps the claim secret. A sandbox gets a pinned profile and narrow scope via [`Board.sandboxPolicy`](../packages/board/src/server/board.ts) when needed. Withhold `/runtime` from credential injection in [`sandbox.ts`](../packages/board/src/server/sandbox.ts). A bare subprocess runs trusted fixtures only. |

Roles constrain existing access. They do not grant it. Bind them in trusted
channel configuration, not to a caller-selected profile, label or reply.

Store task decisions in the board log. Keep provider bookkeeping out of it.
[`attempts.ts`](../packages/board/src/server/attempts.ts) counts A2 retries,
not work attempts.

## Migration and compat with existing tasks

No backfill. Existing tasks keep their states, leases, dependency release
and oldest-first claim order. Keep the root and existing `TaskView.state`
vocabulary. Add an optional managed stage for new clients.

Legacy claims skip or reject managed tasks. Legacy writes, including
indirect task transitions from root edits or dependency completion, cannot
bypass managed gates. Managed dispatch requires `runtime_tasks: 1`, a
proposed field in `Discovery`. If it is absent, do not dispatch. The first
managed backend is the fork's `local()` over HTTP.

## Tests

| Scope | Conformance checks to add |
| --- | --- |
| First slice | Run shared conformance checks against a fake and a real fixture process: duplicate start/send, cursor order, early collect, stable result, timeout and child cancellation. Use the [board test harness](../packages/board/test/harness.ts) with real verification against its test issuer. On lease loss, the fixture stops and no settlement lands. |
| Managed follow-up | Race two claims over HTTP. Reject label and profile spoofing, legacy bypass, stale proof, revoked access, and wrong-head or unsigned verdicts. Test priority order and evidence-only edge release. Check that quota reset and slot release unblock dispatch without overbooking. Keep existing [task conformance](../packages/board/test/conformance.test.ts) passing. |

## Alternatives

| Decision | Alternative and cost |
| --- | --- |
| (a) Enforce rules in the server task contract | Labels plus convention avoid protocol changes, but anyone with `label` can rewrite ordinary labels. Clients can disagree or skip gates. Reserved `board.task` is a server projection. |
| (b) Keep runtime separate from `packages/board` | Putting it inside board couples provider dependencies and releases to the core and widens the diff from upstream. A separate package still needs a task contract extension for managed work. |
| (c) Allow fork-only runtime roles | Grants alone either give reviewers broader permissions or fail to distinguish controllers from reviewers. Under [Non-goals for v1 (SPEC.md:4169)](../SPEC.md#L4169), [SPEC.md:4172](../SPEC.md#L4172) reads “Accounts, login, sessions, roles, and moderating others' messages”. Amend that line only: replace “roles” with “roles (except fork-only managed runtime roles)”. |

## Open questions

Which providers expose reliable window usage and replayable events?
Which git host operation can mark ready with a head precondition? Without
one, leave the PR draft.

## Slices

Three small PRs deliver the first slice. No provider integrations,
scheduler, git watcher or managed task changes.

1. Add the runtime package, harness types, and fake adapter conformance.
2. Add the local subprocess adapter for a fixed fixture in a temporary directory. Pass no credentials.
3. Use the public handle's [`board.tasks.claim`](../packages/board/src/client/client.ts) for an explicitly selected task on a local test board. Run one fixture, use the returned claim's `renew` and `release` methods, and stop on lease loss without completing the task.
