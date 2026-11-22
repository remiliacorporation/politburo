status: proposed
bonklek decides on this PR

# Swarm lifecycle

## 1. Status and scope

WP-601, WP-602 and WP-603 run as services in `packages/swarm`. They use the
public board handle and runtime library. They add no board routes, states,
permissions or backend methods. See [merger](swarm-merger.md) and
[reuse](swarm-reuse.md).

This design replaces held [PR 20](https://github.com/remiliacorporation/politburo/pull/20)
and [PR 21](https://github.com/remiliacorporation/politburo/pull/21), not their
commits. The [earlier design](work-lifecycle.md#status) lists what shipped
separately: bound claims, handoff metadata, priority, parking and pause. The
held stage and evidence code is not on main. [Tasks](../SPEC.md#tasks) still
owns leases and readiness. The swarm owns stage, evidence, the watch loop,
launch recovery and operations reports. No service here merges a PR.

| Held finding or scope | Treatment here |
| --- | --- |
| 20.1 Readiness leaks an unreadable prerequisite | No new readiness route. Refuse private or mixed-audience edges at admission. For caller reads, missing and unreadable look alike. Existing edges with grant drift can still leak readiness through the board. See section 6. |
| 20.2 Public `task.work_resolved` names a hidden prerequisite | Structurally gone. No such event or resolve route. The existing `task.ready` signal remains (`packages/board/src/server/tasks.ts:490-494`); the audience rule still matters. |
| 20.3 Redirect replays claim proof | No submit, attest, override or resolve board routes. Service inputs do not carry board tokens. The handle refuses redirects on existing proof-bearing calls (`packages/board/src/client/client.ts:437-456,1052-1064`). |
| 20.4 Evidence read implies backend enforcement | It does not. A successful read proves nothing about `complete`. Enabling this design is a deployment and grant decision, not capability discovery. |
| 20.5 Renew time and skipped higher-priority leases | No new renew behavior. The main lease race is not fixed here (`packages/board/test/dst/e1-lease.test.ts:5-11`). Swarm selects and claims by id, not claim-next. It does not promise globally strict priority across the read and claim. |
| 20.6 No test crosses a release deadline | The new suite crosses expiry between stage admission and completion. It cannot prove expiry at the board append. There is no dated board edge release to test. |
| 20 next step: decide all checks inside one conditional append | The service has one decision function. The label append only compares labels. There is no joint append for authority, evidence, time and completion. |
| 21 stages and scope as routes | Structurally gone. The service owns them; the board sees ordinary labels and task calls. QA is a gate, not a stage. |
| 21 scoper revocation fence | No scoper board route. Serialize service role changes with service moves. A direct board grant change can still race the service's last caller check. No equivalent to the staged append fence. |
| 21 reopen a finished prerequisite | Not supported in place. The board refuses it. See section 6 for the loss and replacement path. |
| 21 claim file drop strands proof | The service does not use CLI claim files. A lost proof stops the run; the lease expires. The CLI race is neither used nor fixed here. |

## 2. Five rules

1. Bind proof to the thing it proves. Each gate names one task, round and full commit.
2. Separate observation from authority. A report can prompt validation, not grant a move.
3. Make restart safe. Sync intent before sending and probe before deciding what happened.
4. Unknown is not false or zero. An absent check or usage reading stays unknown.
5. Spend model and human attention only on exceptions. Run rules first.

## 3. Stages and moves

`work.stage` and `work.round` are labels on the task root. Only the stage
service principal changes them, by label compare-and-set (`if`), including
initialization (`null` means absent). There is no `work.stage=qa`.

| From | To | Who requests or initiates | Required evidence or precondition | Refusal if missing |
| --- | --- | --- | --- | --- |
| Unmanaged new root | `proposed` | Intake dispatcher | Owned, unsynced work root and intake reference. Set round 1. | `intake_missing` |
| `proposed` | `scoped` | Scoper | Valid outcomes contract, exact root revision, repo, policy version and readable, admitted prerequisites. | `scope_missing`, `outcomes_invalid`, `dependency_unavailable` |
| `scoped`, `repair` | `implementing` | Dispatcher | Current scope, satisfied prerequisites, admission under the pinned policy, live claim by id and matching launch binding. | `scope_stale`, `waiting_on`, `admission_refused`, `claim_missing`, `binding_missing` |
| `implementing` | `review` | Dispatcher on a verified submitter request | Live bound attempt, verified handoff bytes, submission on that commit and a listed outcome met before the claim cutoff. Record the review hold. | `claim_lost`, `handoff_missing`, `submission_missing`, `outcome_missing`, `claim_deadline` |
| `review` | `approved` | Scoper | Current submission and handoff; pass tests, independent review and any enabled QA or acceptance gate. | `submission_missing`, `handoff_missing`, `gate_closed` |
| `approved` | `done` | Stage service on scoper acceptance | All prior gates again, and publication if enabled. A prerequisite needs actual passes, not waivers, before board completion. | `gate_closed`, `release_gate_closed`, `head_changed` |
| `review`, `approved` | `repair` | Reviewer, QA attester or scoper | Bound finding or stated reason and a fix slot. Retire the candidate and increment round. | `repair_reason_missing`, `fix_limit` |
| `implementing` | `repair` | Dispatcher | Recorded lost attempt, release, or miss. Increment round and discard the attempt binding. Apply the claim rule, not a review fix charge. | `attempt_end_missing` |
| `scoped`, `implementing`, `review`, `repair`, `approved` | `proposed` | Stage service on scope invalidation | Root revision mismatch or explicit rescope reason. Retire candidate and offers; increment round and stop any old lease. | `rescope_reason_missing` |
| Any open stage | `rejected` | Scoper | Recorded reason. End any lease and leave a hold. | `rejection_reason_missing` |
| Any open stage or `rejected` | `canceled` | Scoper or jockey | Recorded reason. End any lease and cancel the board task. | `cancel_reason_missing` |
| `rejected` | `proposed` | Scoper | Reopen reason. Increment round and require fresh scope. | `reopen_reason_missing` |
| `done` | No in-place move | Scoper may request a successor | A new task references the old outcome and starts at `proposed`. | `reopen_completed_unsupported` for an in-place request |
| `canceled` | None | None | Terminal. | `stage_conflict` |

Open stages are `proposed` through `approved`, including `repair`. All other
moves return `stage_conflict`. Wrong role returns `forbidden`. A paused board
or operator park stops forward moves (`board_paused`, `task_parked`); cancel
and protective holds can still proceed. Missing evidence includes expired,
failed, wrong-candidate and unverified evidence. `gate_closed` lists the gate
and its reason. Optional QA means a `browserQA` pass where enabled. For
non-code work, pin the commit that holds the declared outcome and proof.

| Boundary | What it decides |
| --- | --- |
| board | Grants, verified author, schema shape, label compare-and-set, task holds, and the existing epoch, token, pause and lease checks. See [board facts](swarm-board-additions.md#what-the-board-already-enforces). |
| stage service | Caller role, current scope, attempt binding, candidate, gates, clock and legal move. No other service writes lifecycle labels. The same service serializes evidence admissions and moves per task, across parties on a repo. |
| label append | Compare both labels and `work.move` (the previous receipt id); set all three in one `label` call. `work.move` prevents a retry against the same stage/round after an intervening write. Conflict means reread and decide again, not retry the old decision (`packages/board/src/client/client.ts:898-903`; `packages/board/src/server/writes.ts:872-895`). |

Before CAS, post a move receipt with a stable request id, previous receipt,
from/to, round, actor, scope or candidate refs, and reason. Use a registered
`swarm-move@1` block. Only receipts reachable from `work.move` count as
landed. The CAS is atomic enough to publish one coherent stage, round and
history head, and make duplicate moves harmless. It cannot compare a root
revision, evidence expiry, grant, claim or pause epoch at that append.

Run one decision function over fresh reads just before each effect. Serialize
cooperating writers. Recheck the root revision, board control and applicable
claim or holds. Persist the request id, expected labels and effect steps in
a local pending move record before the first hold or claim. On restart, check it against
the receipt and actual board state. A pending operation closes admission
for that root. Scope pins `MessageView.revision`, not the version that
changes with labels (`packages/board/src/api/routes.ts:980-993`). Do not
pretend that claim, hold, evidence post and CAS form one transaction.
Direct board writes and time can still race the check.

Keep proposed or invalid work held with `outcomes`; no direct create-and-claim
for lifecycle work. On submission use `claim.handoff` then `claim.block` of
kind `review`. It ends the lease. Verify both before admitting the review
move. Remember the handoff id and generation, not the proof, in the receipt.
If the hold fails, do not admit review. A retry after a landed hold reconciles
that exact submission and hold. On repair, release only the service's own
hold once repair admission permits. A rejected task remains held; a reopen
retains or restores a hold until scoped. Use `tasks.cancel` for cancellation,
not completion. Do not lift a person's park to make a stage move.
See [work items](swarm-work-items.md#claim-rule),
`packages/board/src/client/client.ts:449-456,766-798` and
`packages/board/src/server/tasks.ts:1009-1017`.

## 4. Evidence

| Record | Fields and rule |
| --- | --- |
| Attestation | `id`, `taskId`, `partyId`, `round`, `commit` (full SHA), `gate`, `verdict` (`pass` or `fail`), `artifactRef`, `author`, `at`, `expiresAt`. Service assigns admission time and requires a finite expiry. Gates are `submission`, `tests`, `review`, `browserQA`, `acceptance` and `publication`. |
| Override | Same binding, `id`, `partyId`, `author`, `at`, `reason`, `expiresAt`; distinct kind, not a pass. One task, round, commit and gate. Never replaces handoff or submission. It can waive an eligible gate on a move, not release a dependency or make a PR ready. |
| Artifact reference | Immutable repo and commit plus a repo-relative path, or a fixed attachment id. Both carry SHA-256 of the bytes. No mutable URLs or branch tips. |

The reader checks the service's board-authored `by` and verifies the record
belongs to the task and current candidate. The attester in `author` is an
identity verified and recorded by the service, not a field accepted from the
caller. Read bytes at the pinned commit or through the caller's authorized
attachment read (`packages/board/src/client/client.ts:885-887`). Hash the raw
bytes, compare the digest, then validate the artifact for that gate. Missing
or different bytes close the gate. For a handoff, also match the board's
handoff metadata to the round's submission. Do not fetch with claim proof.

The latest admitted verdict for the exact tuple wins by service admission
order, not worker time. A newer fail beats an older pass. Expiry never
revives an older verdict. An eligible, unexpired override must be recorded
after the verdict it waives; a later verdict supersedes the waiver. Recheck
all due gates on every forward move. Expiry blocks future moves, not the
recorded stage. An already completed board task stays completed.

Store append-only service records as replies with typed `swarm-evidence@1`
blocks on the task thread. Use a `json#swarm-evidence@1` fence in reply text
(`packages/board/src/contract/blocks.ts:1-3,65-71`;
`packages/board/src/client/client.ts:711-714`).
Register that schema and `swarm-move@1` on each board before enabling writes
(`packages/board/src/client/client.ts:843-851`). Use the structural subset in
[board additions](swarm-board-additions.md#needs-checked-and-found-to-need-no-addition).
No `$ref`, `pattern` or `uniqueItems`. The service checks the exact SHA,
fields, binding, time and provenance. A matching schema is not authority.
Use unsynced lifecycle roots; only service-authored records with matching
provenance count. Refuse modified, missing or ambiguous records.

## 5. Authority and trust

Observation never grants authority: not a status file, a wake receipt, a
mirror or worker label, or a PR check seen by the watcher. The last can be
input to a trusted CI attester. Replies and sync imports cannot attest. A
service-written reply is a receipt of a separate authenticated decision.

| Principal | May write |
| --- | --- |
| Dispatcher and stage service | The stage service runs inside the model-free dispatcher, using `swarm:person:dispatcher-<party-id>`, not another `label` principal. The assigned task owner writes lifecycle labels and sealed records. The admitted dispatcher holds claim proof and renews, hands off, releases or holds. Only the owning stage service completes. |
| Scoper / spawner | Requests scope, advances, rescope, reject, cancel and rejected reopen for its repo. No direct lifecycle label grant. |
| Bound submitter | Requests a submission with an authenticated attempt binding. Supplies packet and candidate, never board proof. No direct board grant for a mob. |
| CI, reviewer, QA, acceptor, publisher | Submit authenticated gate-specific attestations to the service. No direct lifecycle label grant. The reviewer is distinct from the submitter by verified principal, not profile. |
| Jockey | Requests overrides with reason and expiry. Uses existing park, unpark, attention and pause as granted. The privileged `label` exception is real, but policy forbids claiming, completing or stage edits. |
| Mirror, sync, intake users | Observations in authorized channels or ordinary discussion where permitted. No `label` in lifecycle work channels. |

Revoke the three starting grants and install explicit `user` grants as in
[board additions](swarm-board-additions.md#method). Keep a unique suffix for
each dispatcher; the host identity is kind `person`. A dispatcher needs
`read`, `post` and `label` in the work channels it serves, not board-wide
`manage` or attention responder status. Schema setup uses a separate board
administrator. Verify roles and read rights at use, not from a cached
request or a self-reported actor. Cloud mobs never reach the board.

## 6. Evidence-released dependencies

The board releases dependents when a task completes, not when it is approved
(`packages/board/src/server/tasks.ts:857-873`). Only the stage service calls
`complete`, and only as part of the move to `done`. It unblocks its review
hold, takes a short settlement claim by id, rechecks all required proofs,
and publishes `done` with CAS before calling `claim.complete`. No worker is
launched for this claim. Recheck immediately before `complete`. If a proof
expires or the board pauses before settlement, close admission and show
`completion_pending`; do not complete on the stale proof. Resume this same
move only with current proofs on its pinned commit and a current claim.
If the pinned candidate cannot be settled, raise attention and keep the board
edge closed. A completed board task ends reconciliation. If proof is lost, wait for expiry
before trying a new settlement claim. This ordering may leave `done` on a
not-yet-completed board task. It does not release a dependent early through
cooperating callers. Time or a privileged board write can still race it.

| Case | Rule or limit |
| --- | --- |
| Edge admission | First version allows edges only within one unsynced lifecycle channel and between managed tasks. That gives both ends the same read audience. Require current read access for the requester on both ends. Deny missing, unreadable and out-of-policy refs without naming them. Validate cycles with the handle and refuse unknown reads. |
| Later edges | Pin prerequisite eligibility at scope. Only eligible tasks can be named, and they need actual passes at completion, even with no dependents yet. Other tasks may finish with a waiver but cannot serve as prerequisites. For an already completed prerequisite check its receipt and current passes before admitting a new edge. |
| Native readiness | `task.ready` says what the board released, not whether a gate is still current. An existing edge is not withdrawn by expiry or a newer fail. The service can refuse its own future dispatch on stale proof. It cannot retract the board event or stop a direct board claim. Existing out-of-policy edges must be audited before enablement. |
| Bypass and trigger | Any principal holding `label` in the channel can claim and then complete with its proof, regardless of gates (`packages/board/src/server/tasks.ts:794-824,857-873`). No per-key label grant. When an independent second principal can claim or complete in a swarm channel, add server-enforced release using the earlier [resolve route](work-lifecycle.md#proposal), with current proof and access checks at append. |
| Trigger on main | Not fired in the deployment model of [board additions](swarm-board-additions.md#method). That is a design finding, not a live grants audit. It assumes one cooperating dispatcher trust domain and the jockey exception by policy. If two independently acting party dispatchers have these grants in one channel, or the jockey uses the exception to claim or complete, this service-only guarantee no longer holds. Keep gated writes off there until the trigger is addressed. |
| Reopen a done prerequisite | Cannot put existing board dependents back to `waiting` in place. `tasks.reopen` only reopens failed tasks and `tasks.needs` cannot change a live claim or finished task (`packages/board/src/client/client.ts:783-792`; `packages/board/src/server/tasks.ts:1022-1030`). Keep old completion. Make a successor; explicitly retarget eligible unclaimed unfinished dependents with `tasks.needs` so they wait for the successor. This is not atomic. There is no automatic recall of ready events, claims or completed dependents. |

## 7. History read and why blocked

`explainWork(callerBoard, workId)` powers `swarm why <work-id>` and its
`--json` output. It is read-only. Find the root by `work.id`, page its thread,
follow the landed move chain, and evaluate evidence with the same read-only
decision rules as a move. Read holds, park, dependencies and claim from the
task view, and pause from control (`packages/board/src/client/client.ts:557,
685-694,751-760`). Use the caller's visibility, not the dispatcher's. Do not
name hidden dependencies, artifact refs or actors. Use `dependency_unavailable`
for a hidden or missing prerequisite and `unknown` for an incomplete read.
The view names closed gates and landed decisions without claim proofs. Neither
format starts a check, repairs a hold or retries settlement.

Illustrative output:

```text
plb-482   review, round 2
review    gate missing
held by   dispatcher-default (review)
waiting   none
claim     none
pause     running (epoch 8)
```

```json
{
  "workId": "plb-482",
  "stage": "review",
  "round": 2,
  "missingEvidence": [{ "gate": "review", "reason": "missing" }],
  "heldBy": { "principal": "dispatcher-default", "kind": "review" },
  "waitingOn": { "workIds": [], "unavailable": false },
  "claim": null,
  "pause": { "paused": false, "epoch": 8 },
  "history": [{ "id": "m12", "from": "implementing", "to": "review", "round": 2 }]
}
```

`claim` is null, `unknown`, or `{actor, until, generation}`. Unavailable
fields are not empty facts. A missing or unreadable root gets the same error.

## 8. Watcher loop (WP-602)

The runtime provides one `watchRemote().poll` for a branch, in-process PR open
dedupe and a check cache by SHA (`packages/runtime/src/remote/watcher.ts:15-45`).
`localGit` reads a file at one ref head and uses CAS for writes; it never syncs
refs (`packages/runtime/src/remote/ref-store.ts:57-128`). `ghCodeHost` reuses a
branch's PR and reads configured checks at the exact commit, not a moving ref
(`packages/runtime/src/remote/gh.ts:91-125`). The loop, trust validation,
status table, stale detection and cleanup are new in swarm.

1. Drain a bounded page of board events and read `status()`. The feed is a
   wake-up hint, not an action ticket (`packages/board/src/client/client.ts:557,991-1041`).
   On restart or a gap, read the board, ledger and journal to rebuild active
   attempts and accepted status cursors before advancing the feed cursor.
2. Select due attempts from the local status table. Fetch exchange refs by
   the configured repo mapping. Read a bounded snapshot and validate below.
   Persist the accepted head, sequence, session, generation and receive time.
   Project a short status to the board under the service identity.
3. Mark stale after the configured interval without a fresh accepted record
   since launch or last progress. Duplicates do not reset the clock. Report
   stale, not finished or failed. Reconcile via the dispatcher; never relaunch
   from staleness alone.
4. For an accepted finished record, ensure the published commit matches.
   Give `watchRemote` the same validated `RefStore` snapshot, not a second
   unvalidated read. Wrap code host writes in the current control check.
   Open or reuse a draft PR by repo and branch; a closed or merged PR is
   history, not a new review. Check that the result and current PR head
   match the candidate before sending an observation to the CI attester.
5. Recheck the head on subsequent ticks. On a new push reconcile draft and
   review as in section 9. Retry reads with bounded exponential backoff and
   seeded jitter in tests. Reset on progress; do not turn an unknown result
   into a pass. External writes reconcile by identity before retry.
6. After confirmed settlement and retention, tag the final exchange heads
   with attempt-scoped archive tags, verify the tags, then delete only refs
   still at the archived heads. Leave live or uncertain work alone. Cleanup
   is repeatable, and the status table records the archive references.

| Status case | Accept or reject |
| --- | --- |
| Known schema version, `working` or `finished`, exact session, brief digest and attempt echo | Accept if the generation, ordering and commit also match. `finished` requires a full published SHA. `working` does not authorize a PR. |
| Unknown field, malformed field or absent required field | Reject as `invalid_status`. Validate a closed schema, not just `state`. |
| Wrong session, brief or attempt | Reject as `binding_mismatch`. Echoes are correlation, not authentication. Read only the configured attempt's ref. |
| Missing or different generation | Reject as `generation_mismatch`; generation is the live claim epoch for submissions, or the registered review attempt generation for reviewer observations. |
| Sequence advances on a descendant of last accepted status head | Accept if it does not move from `finished` back to `working`. Gaps are allowed; a finished attempt stays closed. |
| Same accepted head and sequence | No-op. No progress or stale clock update. |
| Older sequence, equivocation, rewound ref or update after finish | Reject as `status_out_of_order`. A new attempt gets its own binding and cursor. |
| No snapshot or a failed fetch | Unknown. Retry with backoff and run stale detection. Do not open a PR. |

While paused or control is unknown, poll and project read-only observations
as allowed, but make no launch, draft PR open, promotion, cleanup or forward
stage write.
A new epoch closes old intents and old attempts for admission, even after
resume. Keep reconciling actions already sent. If redrafting is deferred by
pause, display the stale head and keep readiness closed. Section 10 defines
the send boundary. `runTask` already monitors a claim's pause epoch and
releases rather than completes (`packages/runtime/src/runner.ts:38-40,92-109,160-209`).
It does not supply the external launch journal.

## 9. Review gate and reviewer start

Use `none`, `minor`, `major`, `blocker` as the signed maximum finding level
([frontend G3](swarm-frontend.md#gaps-that-need-new-infrastructure)). Map an
incoming `high` finding to at least `major`; reject unknown levels. Refuse
`clean` with any `high` or above-minor finding (`review_level_conflict`).
Compute maximum from the reviewed findings, not a free-text claim. The
party policy may be stricter. Never convert an old clean verdict into a pass
after a newer fail. Give the runtime gate only the current eligible verdict.

After exact-head CI passes, start a separate reviewer attempt on that head
through the journal. Bind it to task, round, PR, commit and independent
reviewer principal. Refuse an identity equal to the submitter or an unchecked
head. Pin the party config for one review round and one fix round by default
(`packages/swarm/src/config/defaults.json:97`). Count the review cycle once,
including its post-fix verification; a fix does not buy another open-ended
cycle. Exceeding either limit goes to an attention item. Apply the docs-only
policy to model review, not to the exact-head checks that remain required.

`packages/runtime/src/remote/gate.ts:5-20,29-64` already signs the SHA,
reviewer and outcome, and checks a clean verdict against green checks on the
same head. Add optional `level`. Include it in the HMAC tuple when present.
Verify the original tuple only when the field is absent; absence is unknown,
and swarm refuses it when severity is required. The service verifies attempt
and principal separately before admitting evidence. A key never travels on
an exchange ref. The gate never merges.

Any new push invalidates the verdict and returns the PR to draft. The loop
closes readiness on observing a new head, requests draft conversion, and
waits for a new handoff, check and review on that head. It does not reuse old
verdicts even if the branch returns to the same SHA after retirement. It
requires repair and a new round before admitting the replacement. Draft
conversion is a new code-host operation, not in `CodeHost` today
(`packages/runtime/src/remote/code-host.ts:7-16`). The correction is eventual,
not atomic with a push. Keep ready promotion off where the host cannot fence
all pushes through `markReady` (`packages/runtime/src/remote/gh.ts:127-137`;
[remote work](../packages/runtime/README.md#remote-work)).

## 10. External-action journal and launch recovery

| Field | Contents |
| --- | --- |
| Key | Canonical encoding of work id, round and attempt id. Allocate attempt ids durably once, including reviewer attempts. Scope by repo and provider account. A repeat tick reuses the same key. |
| Binding | Action kind, ledger envelope ref, repo and account, brief ref and digest, expected generation, pause epoch, request digest and timestamps. No credentials, raw prompts or claim proofs. |
| State | `intended`, `sent`, `confirmed`, `uncertain`, `abandoned`. Keep provider session id once known, or a normalized probe outcome and reason. |

One writer holds the key through dispatch and reconciliation. Append and
fsync `intended` before any launch. Recheck the bound epoch and claim, append
and fsync `sent` before calling the provider, then recheck control immediately
before the call. `sent` means the call may have escaped, even if it did not.
Append and fsync `confirmed` on a verified session receipt. Ambiguous response
means `uncertain`, not an automatic retry. A definite local no-send may mark
`abandoned`. A crash before that marker leaves `sent`, so recovery is
conservative. Never reuse an abandoned key for a new launch.

Send the Claude cloud launch the configured repo and environment, brief ref
and digest, base commit, work branch, and attempt binding for the configured
pi work. The remote session title carries the exact journal key. Probe by
exact title in that repo and provider account, validate the binding, and
adopt the session id. A title alone does not authenticate a report. Do not
send board credentials. Use the runtime harness contract for the bound
session (`packages/runtime/src/harness.ts`); the cloud adapter and probe are
new. No provider-side idempotency is assumed.

On restart load durable states and probe before taking action. `Absent`
means an authoritative negative, not an empty first page, elapsed timeout
or eventually consistent listing. Multiple hits, lookup errors and a
binding mismatch are unknown. A valid match is exactly one bound session.

| Journal state | One matching session | Absent | Unknown or ambiguous |
| --- | --- | --- | --- |
| `intended` | Confirm and adopt, never send again. | Continue the first send only if binding and epoch still match. Otherwise abandon. | Mark uncertain and raise attention. |
| `sent` | Confirm and adopt. | Mark uncertain and raise attention; do not resend. | Mark uncertain and raise attention. |
| `confirmed` | Reattach or record terminal outcome. | Keep confirmed identity; flag missing session, no launch. | Keep confirmed identity; retry reads, no launch. |
| `uncertain` | Confirm the found session; no second send. | Keep closed; person decides whether to abandon. | Keep closed and retain one attention item. |
| `abandoned` | Keep closed; flag stray session for cleanup. | Keep closed. | Keep closed; record probe gap if needed. |

Uncertain is never replayed blindly. It raises one deduped attention item for
a person and stays closed to sends. A person can abandon it, but no replacement
launch until the prior session is accounted for or proved unable to act.

Pause fences admission, not the provider. An intent from an older epoch is
void for sending after pause or resume, including an intended row that never
sent. Invalidate it, but still probe a possibly escaped action. If pause
wins after the final check but before provider acceptance, the side effect
can still happen. Reconcile that session, request stop or quarantine, and
admit no result on the old epoch. This design does not promise a distributed
atomic pause or exactly-once delivery. It promises no automatic second send
when the first might have escaped.

Store the journal in an append-only local file beside the ledger, with a
human-readable board mirror of launch, uncertainty and recovery. Sync the
file on every state change and its directory on first creation. Replay only
complete verified records. Torn or corrupt tails and a missing journal after
restore stop dispatch until reconciled. The mirror is not recovery authority.
[AGENTS.md](../AGENTS.md#invariants) puts bookkeeping that people don't read
in side contracts. The board keeps the decisions people read, not the probe
and fsync steps.

## 11. WP-603 operations

| Matrix | Design | Acceptance check |
| --- | --- | --- |
| M36 Usage guard | WP-504 supplies the configurable threshold, default 100%, and reset wake. Reuse its interface here. `usageGuard` today uses 95% and no reset wake (`packages/runtime/src/usage.ts:68-76`). Explicit unknown does not block by itself and does not become zero. | At `stop_percent`, dispatch stops until reset. One deduped wake at reset plus one minute, through restart. Unknown stays visible. |
| M37 Refill | Three researcher prompts look for gaps in tests, docs and outcomes against the open queue. Require a source and a proof plan. The critic checks scope, feasibility and duplication. Revalidate normalized source refs and outcome keys against open work under the intake lock before writing. Reuse `refill`'s held write path (`packages/runtime/src/ops/refill.ts:26-70`) under the dispatcher; its internal temporary prerequisite is not lifecycle work and is never completed. | Seeded dry run proposes at most 15 distinct held tasks, none duplicating open work. Publishing has no claimable gap. |
| M38 Packets and attempts | Reuse `writeResumePacket` and `readResumePacket`; name immutable evidence by digest, not the mutable resume path. Keep notes using `appendAttempt`, and link each note to the WP-103 attempt envelope and outcome. The note file is not the durable launch journal (`packages/runtime/src/ops/packets.ts:38-82`). | A packet on a claimed task reads back identically; resume identifies the prior attempt without replaying its launch. |
| M39 Routing | Keep selection in the runtime router (`packages/runtime/src/router/route.ts:50-105`). Persist cooldown per account and route, mode and daily admissions beside the ledger. Read the task contract and remaining limit before selecting quality, cost or latency mode. | Cooldown and daily admission limit survive restart. Failure classes select the expected next route or refusal. |
| M40 Scoreboard | Reuse the read pattern in `packages/runtime/src/router/scoreboard.ts:49` and `bench-run@1` aggregation in `packages/runtime/src/bench/report.ts:28`. Join only by explicit run and attempt ids. Show passes/checked runs, checked/all runs, known-spend runs/all runs, and known tokens/merged PRs with known attributable spend. Keep benchmark counts separate from production. Unknown spend is never zero. | Real bench-run fixtures rank routes and give numerator, denominator and coverage. Unknown spend stays out of spend ratios and visible in coverage. |
| M41 Access incidents | A normalized login failure blocks that account. Persist one incident per account until verified recovery. Show a configured recovery command as argv, never raw provider error or output. A successful trusted probe clears the block. | Repeated failures or restart leave one incident and one account blocked, other accounts usable, with a recovery command and no raw error. |
| M62 Convergence | Read-only summary over a named repo goal and task set. `converged` only when every task is `done`, board-completed, and every applicable gate has passed for its pinned candidate. Waivers, unknown reads, missing tasks and expired proofs give reasons for `not converged`. | Seed both outcomes. Expiring a pass changes the answer without changing the recorded stage or writing anything. |

## 12. Acceptance

Use a seeded board and fake clock. For the first pass, E1 to E4 in
[the DST harness](../packages/board/test/dst/README.md) supply the model:
schedule explicit actors, step time, and judge only landed history. E1 is the
lease deadline, E2 scoper revocation, E3 prerequisite reopen, E4 claim-file
recovery. The staged cases are not a promise that main passes all four.

| Seeded check | Observable result |
| --- | --- |
| Move parity | Exercise allowed and refused rows, including QA on/off, same-principal review, root edit, wrong round or commit, stale claim, revoked role and mismatched bytes. Competing moves leave one reachable receipt chain. Test missing and hidden alike. |
| Override audit | Read back who and why, the exact tuple and expiry. Deny a different tuple and never create a submission from a waiver. |
| Release deadline | Advance clock past expiry after a release decision but before the final service check. No completion or dependent readiness lands. Also force a late board append after the last service check to document the remaining gap, not assert a server fence. |
| One launch replay test | Kill and restart at each boundary: before and after each durable append, final control read, provider send/accept/reply, and mirror write. Also race pause and resume with send, and run duplicate ticks. Run regression seeds **13, 66, 215 and 257**. Assert no duplicate launch per key, no send admitted under an epoch already closed at the final check, no stale session result admitted, and the expected final stage or closed uncertainty. |
| Mutation checks | Remove CAS, drop the round or commit binding, ignore a newer fail, accept an unsigned severity, skip the last expiry or pause check, move fsync after send, or replay `sent` after an empty probe. Each mutation must fail a named test for an observable outcome. |

Tigeryard's own replay cases are not on this branch. WP-604 delivers them.
The first version builds its own fault model from journal states and the
DST harness idea, including seed replay and readable traces. Matching
Tigeryard case for case is a follow-up, including protocol fixtures, final
stages and signed verdict vectors. A seeded model does not prove disk or
provider durability. Check real restart and probe behavior before cutover.

Keep each PR under about 500 changed lines. Permanent tests name the failure
they catch. Follow [the bloat rule](swarm-merger.md#the-bloat-rule): retain
cutover evidence outside the repo, keep parity cases temporary, and count
source and test lines separately. Core judges the gate.

## 13. Board additions

None required. Do not take a held PR or change board core to start. These
are the triggers in [board additions](swarm-board-additions.md#the-additions)
and its notes, plus the dependency trigger from section 6.

| Trigger | Addition if it fires | Fired on main here? |
| --- | --- | --- |
| A1: a non-dispatcher holds a claim token | Server hard end on renew. | No in the stated deployment. |
| A2: claimed scan costs more than one page on a real repo | Claimant filter. | No evidence of it; not measured. |
| A3: restarts for roster changes become routine | Dynamic attention responders. | No evidence of it; not measured. |
| A4: A1 lands | Claim start and hard end in view. | No. |
| Second independent principal can claim for a party or complete in a gated work channel | Server reclaim rule for the former; server evidence release via `resolve` for the latter. | No in the stated deployment. Privileged bypass remains. |
| Mail senders must set labels rather than the secretary | Per-key label rule. Not needed here. | No decision to require it. |

## 14. Slices

| PR | Slice | Default and missing dependencies |
| --- | --- | --- |
| 1 | This design | No behavior change. |
| 2 | Stages and evidence gate, including history and why | Shadow or off. Use small local stubs for party roles, claim admission and gate adapters. |
| 3 | Journal with launch recovery | Off. Fake provider and ledger envelope stub exercise the boundary. No real launch without verified probe and pause handling. |
| 4 | Watcher loop with review start and severity | Shadow or off. Consume watch, stage and launch interfaces; use typed local fakes for any unlanded adapter, mirror or attention writer. |

Each slice is independently green. A stub never grants authority in live
mode. Live WP-601 and WP-602 wait for plan gate G4. WP-603 follows WP-601 as small, separate off-by-default changes. Its
views consume the ledger and bench interfaces; use a local seeded fixture
until the accounting and incident writers land.

## 15. Open

- Verify actual repo grants, same-channel edge policy and single writer
  across parties before enabling. Decide whether in-place reopen or atomic
  evidence release is a cutover requirement. Neither is built here.
- Pin attester identities, gate TTLs, archive retention and the review fix
  accounting with core. Decide how to handle direct grant races where
  policy requires stronger revocation than the service can provide.
- Verify cloud launch and exact-title lookup, ambiguous outcomes, stop,
  journal restart durability and a real host head fence. No live provider
  contract or draft conversion was tested. Recovery argv needs a provider
  runbook. WP-604 supplies the missing Tigeryard fixtures.
- Read the sibling designs, plan excerpts, Tasks spec, pasted held PR
  findings, runtime sources and README, public handle and selected task
  code, and the DST harness and E1 to E4 cases. Did not fetch the held code
  or run the board, DST, parity, runtime tests or provider calls.
