status: proposed
bonklek decides on this PR

## Status

Implemented on `main` in three PRs, with changes: the operational inbox in
[#9](https://github.com/remiliacorporation/politburo/pull/9), the agent
registry in [#12](https://github.com/remiliacorporation/politburo/pull/12),
and command intents and run health in
[#22](https://github.com/remiliacorporation/politburo/pull/22), with follow-up fixes in
[#30](https://github.com/remiliacorporation/politburo/pull/30). The shipped
contract is [SPEC.md: Agent registry](../SPEC.md#agent-registry) and
[SPEC.md: Operational inbox](../SPEC.md#operational-inbox), and the user guide
is [Agent registry](../packages/board/docs/01-board/13-agent-registry.md).
Inbox mail is board-wide and separate from the registry here, not addressed by
registry ID and channel as proposed.

| Section | Status |
| --- | --- |
| Problem | Implemented. The registry is a roster, the inbox is addressed mail, and `vb agents health` is liveness evidence beyond a lease. |
| Roles | Implemented in #12, as proposed. The eight roles are `AgentRole` in `contract/schemas.ts`, and they are duties that confer no access or task authority. |
| Shapes and routes: registry | Implemented in #12, changed. `GET /ops/agents?channel=`, `POST /ops/agents` (register), `POST /ops/agents/:agent/heartbeat` and `POST /ops/agents/:agent/retire` exist, with `team.agents.list`, `register`, `heartbeat` and `retire` and `vb agents list`, `register`, `heartbeat` and `retire`. The board derives `binding` from the caller, and `Agent` adds `heartbeatAt`. There is no `config` route: a re-registration with the current `ifGeneration` changes the role, parent or harness or re-enables an entry. The list is for one exact channel, includes disabled entries and is not paged. A heartbeat records the time and keeps the generation, and a repeated identical registration is a no-op only with no `ifGeneration` or the current one. |
| Shapes and routes: mail | Implemented in #9, changed. The routes are `POST /operational-inbox`, `GET /operational-inbox`, `POST /operational-inbox/:id/ack` and an archive route, with `team.operationalInbox` and `vb inbox read`, `ack` and `archive`. Mail has no channel, `ttlSeconds`, generation or registry ID. It goes to a verified principal ID or to a role from `board({ inboxRoles })`, takes an optional `expiresAt`, and keeps `seenAt`, `actedAt` and `archivedAt` per principal. `GET /deliveries/:id`, the archive folder and cursor paging are not built. Send is SDK or HTTP only, and `vb inbox <key>` still reads raw sync mail. |
| Shapes and routes: intents | Implemented in #22, changed. `POST /ops/agents/:agent/intents`, `GET /ops/agents/:agent/intents`, `POST /ops/intents/:id/take` and `/report` exist, with the same verbs and the `{ task, epoch }` run. Intents are not a `Delivery` in the inbox. `POST /ops/intents` (`vb agents issue-role-intent`) sends one to every enabled agent of a role in one exact channel, 1 to 64 of them, in one write. `vb agents issue-intent`, `intents`, `take-intent` and `report-intent` are the CLI. Only `status` carries a run, and a probe must name one agent. |
| Shapes and routes: health | Implemented in #22, changed. `GET /ops/health/:task` answers `working` with `validUntil` or `not_confirmed`, and `vb agents health` prints `working until <deadline>` or `stale`, and `--json` wraps the result as `{ health }`. |
| State and storage: registry | Implemented in #12, changed. A new entry is enabled at generation 1, with one role, an optional parent in the same channel and no cycles. Each change advances the generation and clears the heartbeat. One entry per binding per channel, and a retry of an identical registration changes nothing. A change does not rotate the principal. |
| State and storage: mail | Implemented in #9, changed. A newer send with the same recipient kind, ID and topic supersedes the older, and `acted` also records `seen`. Read returns at most 15 active messages, newest first, and archive hides a message for that principal only. There is no `dismissed` state and no archive read. Expiry is checked on read, ack and archive and not recorded, and a send that is already expired is refused. |
| State and storage: intents | Implemented in #22. One take, even on retry. TTL is 1 to 60 seconds, at most 30 for a run probe, and an identical report can be retried while the fences hold. A list returns only pending, unexpired intents matching the enabled generation, at most 15 per page, scanning at most 60. A read writes no expiry or fence event. |
| State and storage: run probes and health | Implemented in #22, changed. A probe checks the live claim, the epoch and the binding from `task.claimed`. A board pause fences the claim, so a probe then answers 409 `claim_lost` until a new claim. `working` needs the newest reported probe for the claim to say `running`, within the earliest of the intent expiry, the lease expiry and a freshness window from the report, 30 seconds by default, set by `local({ agentOps: true, agentHealthFreshnessSeconds })`. |
| State and storage: log | Implemented. Ops facts are private events in the board log, kept out of feeds, threads, watchers and sync. |
| Trust model | Implemented, changed. Registry list needs `read`, and enroll and retire need `manage`. Heartbeat, take and report need `read`, `post` and the entry's binding. Mail send needs `post`, and read, ack and archive need `read`, all across the board, not by channel. Issue needs `manage` or an enabled coordinator or controller parent, with a recheckable issuer. Health needs `read` in the task's channel. Board tokens cannot issue, take or report, and the injected `sync.board` handle gets 403 on every inbox call. |
| Migration and compat | Implemented, changed. `local({ agentOps: true })` or `vb serve --agent-ops` enables the registry, intents and health. Discovery advertises `agent_ops: true` for the registry and `agent_intents: true` for intents and health, and `http()` checks the matching flag on each call (#30). A disabled board, an `http()` board without the flag and `vercel()` answer 501 `no_agent_ops`. The inbox is not behind that flag: `local()` keeps it, `http()` forwards, and `vercel()` answers 501 `no_operational_inbox`. |
| Tests | Implemented, changed. The conformance kit has `agents` and `operational-inbox` groups. Their checks skip on a 501 from the first call, and the registry and run-health checks follow their own discovery flags. Intent paging past 15 is tested, and the inbox archive folder is not built. |
| Alternatives | (a) and (b) as proposed. (c) adopted as roles that are duties, not grants: SPEC.md's non-goals say the registry records duties and the inbox role lists are recipient lists, and neither is general role management. |
| SPEC.md amendments | Changed. Non-goals now says the registry records duties and inbox roles are recipient lists. The proposed edit to the direct-message and receipts non-goal was not made. |
| Open questions | Archive retention is moot, as there is no archive folder. The probe freshness window is 30 seconds by default and configurable. |
| Slices 1 to 5 | Implemented as #12 (registry), #9 (mail, receipts and archive, in a different form) and #22 (intents, health, discovery flags). |
| Beyond the design | `runController` in `packages/runtime` wakes a handler on inbox mail and, when the message is still unacted and `parentOf` names a parent, sends that parent a reference to it ([#23](https://github.com/remiliacorporation/politburo/pull/23)). |

## Problem

[Gap 3](../briefs/pb-1-TIGERYARD-PARITY.md#3-agents-roles-and-the-operational-inbox) needs a roster, addressed mail, and liveness evidence. Leases only reserve work. [`Registration`](../packages/board/src/server/registry.ts) serves watchers and sync; [`pullInbox`](../packages/board/src/server/registered.ts) pulls platform events.

## Proposal

Add fork-only roles and addressed mail. Gap 1's task rules and network pause are out of scope. The board records intents; a separate runtime package acts on them.

### Roles

| Role | Duty |
| --- | --- |
| coordinator | Direct controllers; resolve escalations. |
| issues | Triage reports; draft tasks for authorization. |
| controller | Coordinate runs, verify liveness, escalate failures. |
| implementation worker | Implement scoped changes; submit handoffs. |
| reviewer | Give a verdict on the exact handoff revision. |
| QA owner | Plan and assign checks; consolidate findings. |
| QA runner | Check that revision; return evidence. |
| user watcher | Relay feedback and acceptance requests; never approve for the user. |

### Shapes and routes

Proposed shapes reuse [`Author` and `ChannelPath`](../packages/board/src/contract/schemas.ts). [`Ref`](../packages/board/src/api/routes.ts) validates string references; `ISO` is a UTC timestamp string.

```ts
type Role = 'coordinator' | 'issues' | 'controller' | 'implementation-worker'
  | 'reviewer' | 'qa-owner' | 'qa-runner' | 'user-watcher'
type Binding = Pick<Author, 'principal' | 'profile'>
type AgentConfig = {
  role: Role; parent: Ref | null; harness: string; binding: Binding
}
type Agent = AgentConfig & {
  id: Ref; channel: ChannelPath; generation: number; status: 'enabled' | 'disabled'
}
type Address = { agent: Ref } | { role: Role }
type MailInput = {
  channel: ChannelPath; to: Address; topic: string; text: string; ttlSeconds: number
}
type Receipt = { by: Author; generation: number; at: ISO }
type Mail = Omit<MailInput, 'ttlSeconds'> & {
  id: Ref; recipient: Ref; by: Author; createdAt: ISO; expiresAt: ISO
  state: 'open' | 'acted' | 'superseded' | 'expired' | 'dismissed'
  seen: Receipt | null; acted: Receipt | null; supersededBy: Ref | null
}
type Run = { task: Ref; epoch: number } // existing TaskView epoch, not agent generation
type IntentCommand =
  | { verb: 'status'; run?: Run }
  | { verb: 'inspect' | 'pause' | 'interrupt' | 'resume' | 'collect' | 'poke'; run?: never }
type IntentInput = IntentCommand & { generation: number; ttlSeconds: number }
type Report = 'ok' | 'failed' | 'running' | 'not_running' | 'unknown'
type Intent = IntentCommand & {
  id: Ref; agent: Ref; generation: number; by: Author; createdAt: ISO; expiresAt: ISO
  state: 'pending' | 'taken' | 'reported' | 'expired' | 'fenced'
  taken: Receipt | null; report: (Receipt & { outcome: Report }) | null
}
type Delivery = { kind: 'mail'; mail: Mail } | { kind: 'intent'; intent: Intent }
type Health = { state: 'working'; validUntil: ISO } | { state: 'not_confirmed' }
type Page<T> = { items: T[]; next: Ref | null }
```

Extend `routes` and [`Protocol`](../packages/board/src/api/protocol.ts) through `board()`, not custom [`BackendRoute`](../packages/board/src/server/backend.ts) handlers, which don't receive a verified HTTP caller.

| HTTP under `/ops` | Proposed method: input beyond path → result |
| --- | --- |
| `GET /agents` | `listOpsAgents`: `channel, after?` → `Page<Agent>` |
| `POST /agents` | `enrollOpsAgent`: `AgentConfig & { channel }` → `Agent` |
| `POST /agents/:agent/config` | `configureOpsAgent`: `{ ifGeneration, disable: true }` or `{ ifGeneration, replace: AgentConfig }` → `Agent` |
| `POST /mail` | `sendOpsMail`: `MailInput & { requestId }` → `{ deliveries: Ref[] }` |
| `GET /agents/:agent/inbox` | `readOpsInbox`: `folder?: 'inbox' or 'archive', after?, limit?` → `Page<Delivery>` |
| `GET /deliveries/:id` | `getOpsDelivery` → `Delivery` |
| `POST /mail/:id/receipt` | `receiptOpsMail`: `{ generation, kind: 'seen' or 'acted' }` → `Mail` |
| `POST /mail/:id/archive` | `archiveOpsMail`: `{ generation }` → `Mail` |
| `POST /agents/:agent/intents` | `issueOpsIntent`: `IntentInput & { requestId }` → `Intent` |
| `POST /intents/:id/take` | `takeOpsIntent`: `{ generation }` → `Intent` |
| `POST /intents/:id/report` | `reportOpsIntent`: `{ generation, outcome: Report }` → `Intent` |
| `GET /health/:task` | `getOpsHealth` → `Health` |

### State and storage

| Object | Server rules |
| --- | --- |
| Registry | Enroll enabled at generation 1. One role; optional parent in the same channel; no cycles. ID and channel immutable. After `ifGeneration` check, disable or replace increments generation and fences old writes; repeated disable is a no-op. Replacement enables with a fresh principal; neither IDs nor generation principals are reused. |
| Mail delivery | Snapshot 1 to 64 enabled recipients in the channel by ID or role, otherwise reject. Atomically supersede open mail by sender binding, concrete recipient ID, and topic. Open mail follows the logical recipient across replacement. |
| Mail transitions | `open → acted / superseded / expired / dismissed` moves mail to archive, retaining text and receipts. `seen` records first receipt; `acted` also fills missing `seen`. Terminal receipt writes accept only identical replays. |
| Intent transitions | `pending → taken → reported` (reported goes to archive); unfinished intents archive as `expired` at deadline or `fenced` on target disable or rotation. One take, even on retry; a lost response can lose execution. Harness rechecks generation and deadline before acting. Report requires a valid take and accepts identical replays. `poke` hints wakeup; `pause` targets only that agent. No broadcast or free-form commands. |
| Run probes | At issue, take, and report: live claim, matching epoch and channel, exact target binding from `by` on `task.claimed`. Probe reports `running`, `not_running`, or `unknown`; other intents report `ok` or `failed`. No lease renewal. `Working` requires `running` on the newest reported probe by issue order for the same live claim and enabled generation, with `now < expiresAt`; otherwise `not_confirmed`. |
| Reads | No receipt or state writes. Inbox: open mail and unfinished intents. Archive: terminal items. Check effective expiry and authorization on read. Default and max 15 per folder; oldest first by recipient/order index. Opaque cursor bound to board, recipient, and folder; scan at most 60 rows, advancing past examined rows even on short pages. Restart to see newly archived rows before the cursor. |
| Limits and dedupe | Strict schemas: text ≤ 4 KiB, topic ≤ 64 chars, mail TTL 1 second to 7 days, intent TTL 1 to 60 seconds (max 30 for run probes). Server time, no expiry scheduler. Send and issue dedupe by caller binding, method, and `requestId`; changed input is 409. |
| Storage | Add ops events to [`boardEvents`](../packages/board/src/contract/events.ts) under [`boardContract`](../packages/board/src/contract/contract.ts), with separate [projections](../packages/board/src/contract/reducers.ts) including claim author by task and epoch. Use [`appendFrom`](../packages/board/src/server/writes.ts) to recheck on board-position races, including task changes. Omit ops events from public feeds, threads, watchers, and sync. |

## Trust model

[`identify`](../packages/board/src/server/policy.ts) supplies [`Identity.author`](../packages/board/src/server/backend.ts) for provenance. Check effective [`Access`](../packages/board/src/server/access.ts) via [`grantAccess`](../packages/board/src/server/grants.ts), including caps and `x-board-can`, against the object's channel.

| Operation | Required authority |
| --- | --- |
| Registry | List: `read`. Enroll or configure: `manage`. |
| Mail | Send: `read` + `post`, and an enabled sender binding or `manage`. Receipt or dismiss: `read` + current recipient binding and generation. |
| Delivery reads | Inbox, archive and by ID: `read` + current recipient binding or `manage`. By ID also allows the original sender or issuer if still allowed to send or issue. |
| Issue intent | `manage` or enabled parent binding in role `coordinator` or `controller` with `read` + `post`. Require a recheckable issuer; board tokens aren't recheckable. |
| Take or report | `read` + `post` and enabled target binding, matching generation and unexpired intent. At take, recheck issuer authority using [`BoardBinding.accessNow`](../packages/board/src/server/backend.ts) with stored verified facts and scope, credential expiry if present, and current parent binding if required. Store no credential. |
| Health | `read` in the task's channel. The report attests to the harness's observation, not its truthfulness. |

Hidden objects: 404. Visible stale fences: 409. A current binding is enabled and uses a verified principal unique to its generation; profiles are self-selected. Roles confer no task authority.

## Migration and compat with existing tasks

Opt in on fork [`local()`](../packages/board/src/server/local.ts). Fork [`http()`](../packages/board/src/backend-http/index.ts) forwards only with `agent_ops: true` in discovery. Unsupported ops return 501 `no_agent_ops`. Old clients still work; ops logs require compatible binaries.

No backfill or changes to [`Task`](../packages/board/src/contract/folds.ts), [`TaskView`/`TaskClaim`](../packages/board/src/api/routes.ts), [claim fencing](../packages/board/src/server/tasks.ts), or [batch planning](../packages/board/src/contract/task-batch.ts).

## Tests

Add [conformance](../packages/board/src/conformance/index.ts) for local and HTTP with the [harness verifier and clock](../packages/board/test/harness.ts):

- Reject unauthorized enrollment, cycles, cross-channel parents, stale config, and profile spoofing.
- Check snapshots, supersession, receipt replay, expiry, paging past 15, archive, and feed/sync isolation.
- Race takes; rotate, revoke, expire, and reclaim between calls. Bare claims and late probes never show `Working`; older reports never override newer ones.
- Replay old logs; rerun task conformance; check disabled discovery and routes.

## Alternatives

| Decision | Alternative and cost | Proposal cost |
| --- | --- | --- |
| (a) Server task contract enforces lifecycle, gates, and priority | Labels plus convention: anyone with `label` can rewrite ordinary labels and bypass rules. | Divergent core changes and backend conformance. |
| (b) Separate runtime package | Runtime inside `packages/board`: adapter dependencies and churn increase divergence from upstream vercel/board. | Another package and protocol boundary. |
| (c) Fork-only roles | No roles, only convention: no authoritative role addressing or parent commands. | Fork-only protocol and grant checks. |

Amend [SPEC.md line 4172](../SPEC.md#L4172), the roles non-goal, to except agent duties and ops eligibility in the opt-in fork. Amend [lines 4182-4183](../SPEC.md#L4182-L4183) to except addressed ops mail and per-item receipts, not general DMs, presence, or cursor receipts.

## Open questions

- Archive retention?
- Is 30 seconds enough for remote probes?

## Slices

1. SPEC amendments and registry behind fork opt-in.
2. Addressed mail, supersession, and bounded inbox reads.
3. Receipts and archive reads.
4. Generation-fenced intents and conformance.
5. Run health, compatibility checks, and capability advertisement.
