status: proposed
bonklek decides on this PR

## Status

Shipped on `main` in [#10](https://github.com/remiliacorporation/politburo/pull/10), with changes. The
shipped contract is [SPEC.md: Structured task attention](../SPEC.md#structured-task-attention),
and the user guide is [Tasks](../packages/board/docs/01-board/11-tasks.md).

| Section | Status |
| --- | --- |
| Problem | Implemented. `vb tasks ask` opens a request, `tasks attention` reads it, and `tasks answer` binds an option and a commit. `vb tasks block` still makes a plain hold. |
| Proposal: shapes and routes | Implemented, changed. `POST /tasks/:id/attention`, `GET /tasks/:id/attention` and `POST /tasks/:id/attention/:requestId/answer` exist, with `requestTaskAttention`, `taskAttention` and `answerTaskAttention` on `Protocol`, `team.tasks.ask`, `attention` and `answer` on the handle, and `TaskView.attentionId`. Open and answer return `{ task, attention }`, and the read returns `{ attention }`, `null` for none. The work binding is a flat `commit` (a full lowercase SHA-1 or SHA-256 ID, checked as a string, not against Git), not `WorkRef { commit, generation }`, because there is no lifecycle contract yet. An option routes with `next: 'resume' \| 'fail'`, not `'cancel'`, and a receipt's `routedTo` is `ready`, `waiting` or `failed`. |
| Proposal: write rules | Implemented, changed. Open, convert a plain `needs_input` or `awaiting_approval` hold, replace, answer, `resume` and legacy `unblock` (409 `attention_required`) behave as proposed. Expiry, an edit to the root or its evidence, a wrong request ID or commit, a changed task epoch and a retried answer make an answer 409 `attention_stale`, and an unknown option is 400 `invalid_request`. A `fail` option fails the task with its consequence as the reason, and `vb tasks reopen` reopens it. Canceling the task or deleting its root closes an unanswered request. 409 `attention_route_blocked` is not built, because no lifecycle gate exists to bar a `resume` (evidence gates, #20, and lifecycle stages, #21, are held). |
| Events | Implemented. `task.attention_requested` and `task.attention_answered` fold into the task. |
| Trust model | Implemented, changed. All three routes need `read` (404 when unreadable). A claimed task takes a request only with its live claim. An unclaimed one needs its owner, with `post` or `label`, or `manage`. A `fail` option also needs ownership or `manage`, even with a claim. Answering needs `read`, `post`, and a verified person acting as itself with no profile. The responder list is `local({ attentionResponders: { <channel>: [<principal ID>] } })`, exact channels only, not an `attention-responder` role. |
| Migration and compat | Implemented, changed. No backfill, and replies do not answer. A configured `local()` board advertises `Discovery.task_attention: true`, and `http()` forwards. An unconfigured board and `vercel()` answer 501 `no_task_attention`. Clients need no discovery check before they write, and never fall back to a plain hold. Upgrade every writer before enabling it. |
| Tests | Partly implemented. One optional conformance check runs for boards that advertise `task_attention` (open through a claim, then `claim_lost` and `attention_required`). The race, role, expiry, stale-snapshot, replace, cancel and CLI checks are in `packages/board/test/task-attention.test.ts` and `cli-task-attention.test.ts`, over HTTP, not conformance. `task-attention-feed-watch.test.ts` covers watcher delivery and the feed. The design's lifecycle-generation cases are not built. |
| Alternatives | Decided as proposed. The runtime is `packages/runtime`, apart from `packages/board`. The responder list is a deployment setting, not a general board role. |
| SPEC.md amendments | Changed. SPEC.md has a new Structured task attention section, plus edits to the sections that name holds, `unblock` and permissions. It does not add a general role. |
| Open questions | Not built. A channel does not cap the request lifetime, and the inspector does not surface expired requests. The inspector shows a structured hold like a plain one and still offers unblock, which the server refuses with `attention_required`. |
| Slices 1 to 5 | Implemented as one change: events and views, local open, read and replace, the responder check and atomic answer, HTTP, discovery and the SDK, and the three CLI commands. |

## Problem

Gap 2 in TIGERYARD-PARITY: `vb tasks block --kind needs_input|awaiting_approval`
records a reason and ends the claim. A reply binds neither option nor commit.
`unblock` neither checks the reply nor routes work. See
[SPEC.md: Blocking for a person](../SPEC.md#blocking-for-a-person),
[`TaskHoldKind`](../packages/board/src/contract/schemas.ts#L170-L175), and
[`BlockTaskBody`](../packages/board/src/api/routes.ts#L392-L400).

## Proposal

Keep one current request on the task root. Bind it to the lifecycle contract's
recorded commit and generation, not a live Git head. A later gate may spend the
receipt only against that same work.

Proposed wire shapes use `Ref`, `MessageView.revision`, `TaskClaim`, and
`TaskView` from [`api/routes.ts`](../packages/board/src/api/routes.ts), and
`Author` from [`contract/schemas.ts`](../packages/board/src/contract/schemas.ts).

```ts
type WorkRef = { commit: string; generation: number } // full object ID, not a branch or short SHA
type AttentionDraft = {
  kind: 'needs_input' | 'awaiting_approval'
  question: string
  context: string
  options: { id: string; label: string; consequence: string; next: 'resume' | 'cancel' }[]
  evidence: { message: Ref; revision: number }[] // live messages in this task's thread
  expiresAt: string                           // future ISO instant
  work: WorkRef
  revision: number                            // root revision the requester read
}
type RequestAttentionBody = AttentionDraft & {
  claim?: Pick<TaskClaim, 'epoch' | 'token'>
  replaces?: Ref                              // current request ID, if replacing one
}
type AttentionAnswerBody = { option: string; commit: string }
type AttentionReceipt = {
  option: string
  by: Author                                  // server-authored, as is the requester
  at: string
  routedTo: 'ready' | 'waiting' | 'canceled'    // state at the answer, not today's state
}
type AttentionView = AttentionDraft & { id: Ref; by: Author } & (
  | { status: 'pending' | 'stale' | 'canceled' }
  | { status: 'answered'; receipt: AttentionReceipt }
)
```

Strict bodies. Use `storable` text, `TaskNote` limits for question, label and
consequence, and at most 4,000 characters of context. Take 2 to 8 options with
distinct IDs of up to 64 characters, and 1 to 8 evidence refs. Fetch no URLs.

| Route | New `Protocol` method | Input besides path refs | Answer |
| --- | --- | --- | --- |
| `POST /tasks/:id/attention` | `requestTaskAttention` | `RequestAttentionBody` | 201 `{ task: MessageView, attention: AttentionView }` |
| `GET /tasks/:id/attention` | `taskAttention` | none | 200 `{ attention: AttentionView \| null }` |
| `POST /tasks/:id/attention/:requestId/answer` | `answerTaskAttention` | `AttentionAnswerBody` | 200 `{ task: MessageView, attention: AttentionView }` |

Add to [`routes`](../packages/board/src/api/routes.ts#L1199),
[`Protocol`](../packages/board/src/api/protocol.ts), and the handle's `tasks`.
`TaskView.attentionId?: Ref` points to the latest request.

| Write or condition | Checks and effect |
| --- | --- |
| Open from ready, waiting, or claimed | Match work, root revision and evidence revisions. Record an immutable request ID and the task epoch. Set `blocked` with the question as its reason. End any claim. |
| Open on a plain human hold | The same snapshot checks apply. Owner or channel `manage` can convert a `needs_input` or `awaiting_approval` hold. Other holds, including `edited`, are not converted. |
| Replace a pending or stale request | Owner or channel `manage` must name the current ID in `replaces`. Check the new snapshot as on open. Keep the hold. The old ID is stale. |
| Answer a pending request | Match the current ID, commit, work generation, task epoch, root revision and live evidence revisions. On each write attempt, require server time strictly before `expiresAt`. An unknown option is 400 `invalid_request`. |
| Route `resume` | Clear the hold. Set `ready` if current prerequisites are met, or `waiting` if not. Keep the assignment. If another lifecycle gate bars the route, return 409 `attention_route_blocked` and write nothing. Never restore the old lease. |
| Route `cancel` | Clear the hold and cancel with the option's consequence as the reason. Dependents stay waiting. |
| Expired, changed, replaced, canceled, or already answered | Refuse the answer with 409 `attention_stale`. Expiry or a changed snapshot leaves the task blocked. Reread for the latest status or receipt. |
| Legacy `unblock`, cancel, or root delete | `unblock` on a structured hold returns 409 `attention_required`. Cancel or delete closes an unanswered request in the same write. |

Reuse [`server/tasks.ts`](../packages/board/src/server/tasks.ts)'s `changeTask`,
`fenced` and `satisfied`. Recheck one snapshot per
[`appendFrom`](../packages/board/src/server/writes.ts#L620-L626) attempt.
Add `task.attention_requested` and `task.attention_answered` to
[`BoardEvent`](../packages/board/src/contract/events.ts). Each folds into
[`Task`](../packages/board/src/contract/folds.ts#L19) with its hold or route.
History stays in the log. No watcher applies answers. Never log claim tokens.

## Trust model

[`Policy.identify`](../packages/board/src/server/policy.ts) supplies
[`Identity`](../packages/board/src/server/backend.ts#L15-L19).
[`grantAccess`](../packages/board/src/server/grants.ts#L129-L146) accounts for
channel grants, caps and token narrowing. [`ProjectIdentity`](../packages/board/src/server/identity.ts)
names the host project and team. Discovery is not caller proof.

| Action | Server checks |
| --- | --- |
| Read | All routes need `read` on the task's channel. An unreadable root is 404. Details and events use the same channel filter. |
| Open or replace | As `block`: a live `epoch` and `token` for a claimed task, otherwise its owner (`ownedBy`, with `post` or `label`) or channel `manage`. An option that cancels also needs the existing cancel authority, even with a claim. |
| Answer | Effective `read` and `post` in the channel, and a verified `person` acting as itself whose principal ID is in the server-configured `attention-responder` role for that channel. Neither `manage` nor a claim substitutes for the role. |

Roles add no channel access. A profile, handle, sync author, or request field
cannot confer the role. Do not give agents a responder's credential. Grants
are checked per request, not in a transaction across the access and board logs.

## Migration and compat

No backfill. Plain holds and replies still work. Replies never answer a request.
Replay with [`foldMessages`](../packages/board/src/contract/folds.ts) into
versioned tables and [`messagesReducer`](../packages/board/src/contract/reducers.ts).
Keep `board.task` derived. Upgrade all writers before enabling writes.

Enable on `local()` first. `http()` forwards to the authority. If discovery
omits `task_attention: true`, do not send a structured write. Updated
unsupported backends, including `vercel()`, return 501 `no_task_attention`.
Do not fall back to a plain hold.

## Tests

Add an optional conformance group beside
[`tasks.block`](../packages/board/src/conformance/index.ts#L1458-L1475).
Use real HTTP for races, a controlled clock for expiry, and distinct verified
principals. Skip the feature checks on unsupported boards.

| Check | Expected result |
| --- | --- |
| Open with a live claim, then try the old token and both claim paths | Old token is `claim_lost`. No claim while held. |
| Race two answers, then resend the winner | One receipt and one routed transition in the feed. The loser and resend get `attention_stale`. |
| Expire, edit root or evidence, change work, replace, or cancel | Old answer is `attention_stale` with no write. Test both generations of the same commit. |
| Resume with an unmet need, resume with all met, cancel | Answer and destination show together. Cancel releases no dependent. |
| Try read-only scope, wrong principal, profile, label, or synced reply | No answer. Unreadable task is 404. Legacy unblock cannot lift the structured hold, even for `manage`. |
| Replay the log; read an old task; call an unsupported backend | Same receipt and task state after replay. Plain block and unblock still work. Unsupported writes make no change. |

## Alternatives

| Decision | Alternative and cost |
| --- | --- |
| Enforce lifecycle, gates and priority in the server task contract. | Labels plus convention save contract changes, but anyone with `label` can write ordinary labels. Even label `if` cannot check a commit, responder or route. Reserved `board.*` labels stay derived. |
| Keep any runtime in a separate package. | Putting it in `packages/board` couples dispatch and provider changes to the board package. It widens the diff from upstream `vercel/board`. |
| Allow roles as a fork-only extension. | Existing grants alone avoid role config, but require broad `manage` or let ordinary posters answer. |

For roles, amend [SPEC.md:4172](../SPEC.md#L4172) (`Accounts, login, sessions,
roles, and moderating others' messages`) and
[764–768](../SPEC.md#L764-L768) (`Authorization in v1`) to name the fork-only
task action check. Keep profile permissions and channel grants unchanged.
For attention, add exceptions at [3625–3628](../SPEC.md#L3625-L3628),
[3687–3689](../SPEC.md#L3687-L3689), [3698](../SPEC.md#L3698),
[3874–3887](../SPEC.md#L3874-L3887), [4015–4016](../SPEC.md#L4015-L4016),
[4041–4044](../SPEC.md#L4041-L4044), and [4134–4137](../SPEC.md#L4134-L4137).
The structured fields are not a general task `data` field.

## Open questions

- Should a channel cap the request lifetime?
- Should the inspector surface expired requests before other holds?

## Slices

1. Add event and view shapes against the lifecycle work binding. Test replay.
2. Add local open, read, and replace behind a disabled feature flag.
3. Add the responder check and atomic answer. Add race and stale checks.
4. Wire HTTP, discovery and the SDK. Run conformance over HTTP before opt-in.
5. Add CLI commands to open, read and answer.

Leave [`batchPlan` and `BatchNeed`](../packages/board/src/contract/task-batch.ts)
unchanged. Batch creation does not open requests.
