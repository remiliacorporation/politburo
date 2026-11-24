status: proposed
bonklek decides on this PR

# Board additions for the swarm layer

`packages/swarm` needs nothing from `packages/board/src` that must land first. This document checks every server-side need of the [merger design](swarm-merger.md) against what `main` already enforces, and lists the four additions that could still be worth making, each with its smallest shape and a trigger for adding it. Each can live in `packages/swarm` today. The board core stays as it is until a trigger fires.

The rule it applies is the plan's: only what must be enforced on the server goes into the board (plan 3.1), and the list is batched here, once, so a later work package does not reopen the board on its own. Anything under `packages/board/src/inspect` is the UI and is listed apart at the end.

**Contents**

1. [Method](#method)
2. [The additions](#the-additions)
3. [What the board already enforces](#what-the-board-already-enforces)
4. [Needs checked and found to need no addition](#needs-checked-and-found-to-need-no-addition)
5. [Shapes, if a trigger fires](#shapes-if-a-trigger-fires)
6. [Outside this list: the inspector](#outside-this-list-the-inspector)
7. [Open](#open)

## Method

The design makes one assumption that removes most board work: **mobs never reach a board** (D4, [hosting and access](swarm-merger.md)). Every claim on a repo board is made, renewed and settled by one model-free service per party, the **dispatcher**, which runs on the Mac Studio. The board sees a handful of party principals, not hundreds of mobs. That gives the swarm layer a trusted claimant to put the party rules in, and it lets the board's own claim rules (a fenced token, a lease on the board's clock, one claim per task) do the part that must be a server fact.

Two grants make that assumption real, and the design depends on them:

- `label` in `work/` goes to the dispatcher principals and the jockey only. A claim by id needs `label` in the task's channel (`packages/board/src/server/tasks.ts:794-799`), so nobody else can claim; the jockey's `label` is a privileged exception. A board starts with three grants: every person gets everything, every project and every app get `label` everywhere (`packages/board/src/server/trust.ts:56-65`). A swarm board revokes all three starting grants when it is created and writes an explicit `user` grant for each principal (`{ kind: 'user', userId }`, `packages/board/src/api/routes.ts:447-451`). A person can still claim, because the starting grant gives people everything; by policy the jockey does not, and the inspector offers no claim key to a person (see [work items](swarm-work-items.md#row-and-scopes)).
- Each party's dispatcher is a separate host principal, so the board's `claim.actor` names the party (`packages/board/src/contract/folds.ts:37`). Its id has the form `swarm:person:dispatcher-<party-id>`, which satisfies the pattern at `packages/board/src/server/auth.ts:655`. It is kind `person`, not `external`: a host principal of any other kind is refused with 403 unless its id is a Vercel deployment's, because `byGrants` finds no facts for it (`packages/board/src/server/auth.ts:495`, `packages/board/src/server/auth.ts:586-589`). A person is matched to grants by the part of its id after the second colon (`packages/board/src/server/auth.ts:384,395`; `packages/board/src/server/grants.ts:58`), so that part is unique per principal and drawn from letters, numbers and `._-`. Kind `person` carries no extra power on its own: pausing needs board-wide `manage` and answering attention needs the responder list (`packages/board/src/server/a2.ts:312-325`, `packages/board/src/server/tasks.ts:943-949`), and a dispatcher holds neither.

Each row below was checked in `packages/board/src` on `main` (`5f80e1b`), by reading the code, not by running it. Where SPEC.md and the code disagree, the code is cited.

## The additions

| # | Addition | Why it would be enforced on the server | Smallest shape | Needed by | What exists that serves instead | Could live in `packages/swarm`? | Verdict |
|---|---|---|---|---|---|---|---|
| A1 | A claim has a hard end that a renew cannot move (D20: `claims.hours`, 4 by default, hard cutoff) | A claimant that holds the token can renew past any number it keeps for itself: renew sets `until = now + lease` with no total (`packages/board/src/server/tasks.ts:850`) | `ClaimTaskBody.hold` in seconds, stored on the claim; renew clamps `until` to `claimedAt + hold`; see [A1](#a1-hard-end-of-a-claim) | WP-402 | The lease. A lease is at most 3600 s (`packages/board/src/server/tasks.ts:21-22`) and the board expires a lapsed claim on its own clock (`packages/board/src/server/tasks.ts:107-112`). The dispatcher stops renewing at the hard end, and the board ends the claim within one lease: a lease is at least 30 seconds, so the claim can run at most 30 seconds past the hard end | Yes. Only the dispatcher renews (grants above), and a stopped renew is the safe direction | **Deferred.** Add when a principal other than a dispatcher holds a claim token |
| A2 | List tasks by claimant (`GET /tasks?claimant=<actor>`) | Caps count a party's open claims before each claim; a filter on the server turns a paged scan into one read | A `claimant` filter on `TasksQuery` beside `by`, `owner`, `for` (`packages/board/src/api/routes.ts:370-382`), matching `task.claim.actor` | WP-402 caps, WP-409 | `GET /tasks?state=claimed` pages up to 500 rows (`packages/board/src/api/routes.ts:386`); each row carries `claim.actor` (`packages/board/src/api/routes.ts:944-951`). The dispatcher keeps the count from the event feed | Yes. A scan of one repo's claimed tasks, in one process | **Deferred.** Add when a claimed scan costs more than one page on a real repo |
| A3 | Attention responders that change without a restart | A party member joins or leaves; the people allowed to answer a human decision change with them | `attentionResponders` accepts a function `(channel) => principal ids`, in `LocalOptions` (`packages/board/src/server/local.ts:15-32`) | WP-401, 406 | A fixed map at start: `local({ attentionResponders })`, which `vb serve --swarm` fills with the local owner under `*` (`packages/board/src/cli/swarm.ts:5-28`) | Yes. `swarm serve` restarts the board process on a change; the jockey and a few named people answer, so changes are rare | **Deferred.** Add if restarts for a roster change become routine |
| A4 | A claim start time in the task view | The inspector shows a claim countdown to the hard end; today the view has `until` (a lease) and `binding`, not when the claim began | `claim.since` (and, with A1, `claim.holdUntil`) in `TaskView.claim` (`packages/board/src/api/routes.ts:944-951`) | WP-404 | The dispatcher records `work.claimed_at` and `work.hold_until` as labels on the task root, set with `if` absent. Labels are observation, not authority (design rule 2); the board's `until` stays the authority | Yes | **Deferred.** Moves with A1; the UI may read labels until then |

The table is the whole list. **No item is required for any work package to start.** WP-402's "board additions from WP-101's list" is empty unless core takes a verdict above.

### Why these four, and not more

A change that is not here was checked and found to have an existing piece. [Needs checked](#needs-checked-and-found-to-need-no-addition) lists them with the line that serves each.

## What the board already enforces

The party rules rest on these board facts, so the design treats them as given. Each is a server fact today.

| Fact | Where | Used by |
|---|---|---|
| One claim per task, fenced by an epoch and a token hash; a second claim on a live task is 409 `task_claimed` | `packages/board/src/server/tasks.ts:343-351`, `packages/board/src/server/tasks.ts:367`, `packages/board/src/server/tasks.ts:374-383` | "Two simultaneous claims make one" (WP-402) |
| A claim carries a lease on the board's own clock; a lapsed claim reads as `ready` and is claimable at once | `packages/board/src/server/tasks.ts:107-112` | The 4-hour rule's board clock; a dead mob visible before 4 hours |
| Renew needs the live epoch, token and principal | `packages/board/src/server/tasks.ts:845-856` | Only the dispatcher renews |
| A held task refuses claims (`blocked`) and parking is a person's act | `packages/board/src/server/tasks.ts:363-364`, `packages/board/src/server/tasks.ts:985-1006` | A ticket with no valid contract is not claimable (WP-401) |
| Network pause is board-wide, by a person with `manage`, and fences every lease | `packages/board/src/server/a2.ts:312-325`, `packages/board/src/server/tasks.ts:343-351` | The jockey's stop on a repo board |
| Structured attention: a question, 2 to 8 options, a bound commit, answered by a listed person | `packages/board/src/contract/attention.ts:13-54`, `packages/board/src/server/tasks.ts:900-967` | "Needs you" decisions (WP-401, 406) |
| Label compare-and-set: `if` is checked at the deciding append, 409 `label_conflict` | `packages/board/src/server/writes.ts:884-895` | Mail take, serials, config version, work-id counter |
| Post idempotency by a caller's `id` | `packages/board/src/api/routes.ts:160-181`, `packages/board/src/server/writes.ts:289-312`, `packages/board/src/server/a2.ts:458-468` | Mail dedupe, relay, the mirror |
| Typed blocks are validated against a registered schema before the backend sees a write | `packages/board/src/server/serve.ts:511-533`, `packages/board/src/contract/data-schemas.ts:9-18` | `swarm-message@1`, `swarm-digest@1`, party config |
| Labels under `board.` are the board's alone | `packages/board/src/contract/schemas.ts:12`, `packages/board/src/server/serve.ts:108-111` | The swarm's own labels use other prefixes (`swarm.`, `work.`, `party.`) |
| Grants are per channel or subtree, most specific wins | SPEC.md:1052-1064, `packages/board/src/server/grants.ts:153` | Party privacy on `party/<party-id>/`, who may claim |
| A host's own verifier takes any request shape, and returns a principal | `packages/board/src/server/auth.ts:610-627` | The Cloudflare layer lives here, not in the board |
| Provenance is written by the board: `by` is the verified actor | AGENTS.md:336-337, `packages/board/src/server/tasks.ts:379-382` | A party is its dispatcher's actor, never a body field |

## Needs checked and found to need no addition

| Need of `packages/swarm` | Existing piece | Detail |
|---|---|---|
| The 4-hour clock on the board's clock | Lease expiry on the board's `Date.now()` | The board computes `until` and tests it itself (`packages/board/src/server/tasks.ts:850`, `packages/board/src/server/tasks.ts:109`); the client sends durations only. The dispatcher derives the hard end as claim time plus 4 hours and never reads a party host clock |
| Settle a satisfied claim | `block` of kind `review` | The dispatcher, as the task's owner and the holder of the claim proof, holds the task, which ends the claim and refuses further claims (`packages/board/src/server/tasks.ts:363-364`, `packages/board/src/server/tasks.ts:881-895`); the owner lifts it with `unblock` (`packages/board/src/server/tasks.ts:969-979`); a lapsed lease would read as ready (`packages/board/src/server/tasks.ts:107-112`). Acceptance completes it; rejection lifts the hold |
| Release at a miss | `task.expired` | The board writes it in the same append as the next claim attempt, or on its timer (`packages/board/src/server/tasks.ts:185`, `packages/board/src/server/tasks.ts:381`) |
| Same-party reclaim block (15 minutes) | The dispatcher | A party's own dispatcher refuses its own reclaim. A different party claims at once, as the plan says. Cooperative inside one trust domain; see [Open](#open) |
| Open and uncommitted claim caps | The dispatcher | One writer per repo and party; it counts from the feed (A2 if a scan is too costly) |
| Dock, score, scorecard | Records and labels written by the swarm layer | The board has no party, score, dock or budget concept (searched `packages/board/src`: no hit); none is needed there |
| Claim only a valid contract | `block` with kind `outcomes` | A held task answers `task_blocked` to a claim (`packages/board/src/server/tasks.ts:364`), placed and lifted by the task's owner, the dispatcher (`packages/board/src/server/tasks.ts:881-895`, `packages/board/src/server/tasks.ts:969-979`). The validator holds and releases; "Needs you" is the held group |
| A party's identity on a claim | A principal per dispatcher | `claim.actor` and `Author` carry principal and profile (`packages/board/src/contract/folds.ts:37`, `packages/board/src/contract/schemas.ts:145-149`). `binding` is claimant-attested metadata and is not used for identity (`packages/board/src/contract/task-authority.ts:17-30`) |
| Work id `<tag>-<number>`, never reused | A label `work.id`, issued from a counter | The board's task id is the root message id, shared with every message, so it cannot be dense. A counter is a label on one pinned message, moved with `if` (the pattern of G12 in [the frontend design](swarm-frontend.md#gaps-that-need-new-infrastructure)) |
| Message expiry (p2, p3) | The reader | The board has no expiry on channel messages (`PostBody` has no such field, `packages/board/src/api/routes.ts:160-181`); the secretary enforces `expires` |
| Pin a config field | The config service principal and a channel grant | There is no per-key label ACL: channel authorization is by permission alone (`packages/board/src/server/a2.ts:675`), and the only key rule is the `board.` prefix (`packages/board/src/server/serve.ts:108-111`). Only the config service and the jockey get `label` on the config channel |
| Party membership to access | Grants and a party registry in `packages/swarm` | `GET/POST /grants` take principals by id or kind (`packages/board/src/api/routes.ts:444-470`); the registry writes grants through the handle |
| Identity through the tunnel | `board({ authenticate })` | One function that composes (SPEC.md:700-707); returns a host principal checked for shape (`packages/board/src/server/auth.ts:650-681`) |
| A party's stop on its own work | The dispatcher | Pause is board-wide, so a party-level stop cannot be a board pause. The dispatcher stops claiming and stops renewing |
| Block shapes for mail and digest | `POST /schemas` | Registered per board. The schema language is a structural subset: no `$ref`, `pattern` or `uniqueItems` (SPEC.md:1528-1537); `swarm-message@1` and `swarm-digest@1` stay inside it. The party config tree is validated by the config service with full JSON Schema, and the board holds it as a block with a shallow registered schema |
| Several boards, one process each | `vb serve --dir` and `--port` | One process owns one directory (`packages/board/src/store/directory-lock.ts:9-20`) |
| Reading from outside the process | `GET /events`, `GET /threads` | Long-poll and SSE (`packages/board/src/api/routes.ts:150-158`, `packages/board/src/server/serve.ts:1313`) |

### One hosting fact that is not a board change

`vb serve --swarm` cannot take a custom `authenticate`, and refuses `--team-tokens` (`packages/board/src/cli/swarm.ts:11-14`). The tunnel needs a Cloudflare verifier, so the Mac Studio's boards run as `swarm serve`, a process of `packages/swarm` that builds the same board from public pieces: `board({ backend: local({ dir, agentOps, attentionResponders, politburo: 1 }), authenticate })`, using the root export (`package.json:29-33`) and `./backend-local` (`package.json:58-61`). Its options are `--swarm`'s (`packages/board/src/cli/swarm.ts:23-27`). The CLI's own wiring, which this replaces, is `serveLocal` (`packages/board/src/cli/serve.ts:177-300`).

Two consequences for [hosting](swarm-merger.md):

- A host `person` is a team person with grant g1, which is everything (`packages/board/src/server/trust.ts:56-65`; SPEC.md:700-720), until that grant is revoked. A colleague who signs in through Cloudflare maps to kind `person` with an id of the form `cloudflare:person:<email with @ written .at.>`, so that a `user` grant can name it (`USER_ID` allows letters, numbers and `._-`, `packages/board/src/server/auth.ts:269`). The board gives it only the explicit grants written for it, after g1 is revoked. SPEC.md:700-720 says an `external` principal gets what grants give its ID, but the code refuses a host principal of that kind (`packages/board/src/server/auth.ts:495`); this design takes the code and WP-113 proves it on a seeded board. People who answer an attention request or pause a board must be persons with the responder entry or board-wide `manage` (`packages/board/src/server/tasks.ts:943-967`, `packages/board/src/server/a2.ts:312-325`), which in practice is the jockey.
- `swarm serve` re-implements the Host check that `vb serve` does (`packages/board/src/cli/serve.ts:326-330`; `hostCheckedBy` only marks the options, `packages/board/src/server/board.ts:168-173`). It is a few lines, and the tunnel's own listener binds loopback.

## Shapes, if a trigger fires

These are the smallest changes, written so that adopting one is a work package and not a design.

### A1 hard end of a claim

- Request: `POST /tasks/:id/claim` and `POST /tasks/claim` take `hold` (seconds, at most 86400). Schema beside `lease` (`packages/board/src/api/routes.ts:392`, `packages/board/src/api/routes.ts:401-410`).
- Rule: the claim stores `holdUntil = now + hold` at the claiming append. Renew sets `until = min(now + lease, holdUntil)` (`packages/board/src/server/tasks.ts:850`). A claim whose `until` equals `holdUntil` expires normally; the `task.expired` payload gains `reason: 'hold'`.
- Fold and view: `claim.holdUntil` in `Task` (`packages/board/src/contract/folds.ts:37`) and in `TaskView.claim` (`packages/board/src/api/routes.ts:944-951`).
- Backends: `local()` implements it. `vercel()` and `http()` to a board without it answer 501 `no_claim_hold`, as other optional task features do (SPEC.md:4613). A conformance group `claim-hold` checks the clamp and the expiry reason.
- Not in it: no dock, no cooldown, no party. Those stay in the swarm layer.

### A2 claimant filter

`claimant` on `TasksQuery` (`packages/board/src/api/routes.ts:370-382`), a handle or actor id as `by` takes, matched on `task.claim.actor`. Server side the list code already walks tasks (`packages/board/src/server/tasks.ts:738-792`); the filter is one more predicate. No new index.

### A3 attention responders as a function

`attentionResponders?: Record<string, string[]> | ((channel: string) => readonly string[] | Promise<readonly string[]>)` in `LocalOptions` (`packages/board/src/server/local.ts:15-32`). The answer path reads it where it reads the map now (`packages/board/src/server/tasks.ts:948`). No route changes.

### A4 claim start in the view

`claim.since` (ISO) in `TaskView.claim`, taken from the `task.claimed` event the fold already reads. With A1, `claim.holdUntil` beside it.

## Outside this list: the inspector

These are UI changes in `packages/board/src/inspect`. They are work of WP-113 and WP-404, not board core, and are listed so a reviewer does not look for them above.

| Need | Today | Change |
|---|---|---|
| Colleagues act as themselves in the inspector, behind the tunnel | The public `inspector({ board, basePath })` acts as the one handle it is given (`packages/board/src/inspect/handler.ts:32`). `vb serve` has a per-visitor identity for Tailscale (`createInspector({ visitor })`, `packages/board/src/inspect/server.ts:49`, `packages/board/src/cli/local.ts:108`), which is not exported | Export a visitor-aware inspector that takes the identity the Cloudflare layer verified. Until then colleagues run `vb inspect` on their own machine, as plan 3.3 says |
| Party labels, colours and the work board | The current routes have no party-config view (`packages/board/src/inspect/app/routes.ts:6-13`) | Read the party config through the board handle only (`app/board.ts`) |

## Open

Found here. None needs a person from plan section 10.

1. **How to read D20's "the board ends the claim".** This design reads it as the board's own lease expiry on the board's clock, brought to the hard end by the dispatcher (A1 deferred). A reader who needs the end to hold even against a claimant that holds a token takes A1 at once. Core decides when it reviews WP-402.
2. **The reclaim block is cooperative.** A party's dispatcher enforces its own 15 minutes. A principal with `label` in `work/` can claim around it. The grants above close that door; if a party ever gets a second claiming principal, the block moves to the board (a claim-time rule keyed on `claim.actor`), which is a larger change than A1 to A4 and is not designed here.
3. **Host principals are kind `person`, matched by the suffix of their id.** The id pattern needs `<word>:<word>:<rest>` (`packages/board/src/server/auth.ts:655`). Two principals whose suffixes are equal would share grants (`packages/board/src/server/auth.ts:384`), so the registry keeps every suffix unique. That a `person` with explicit `user` grants holds `label` at `work/` and is refused `manage` is read from the grant rules (SPEC.md:1052-1064) and the code above, not run. WP-113 and WP-403 prove it on a seeded board, and prove the starting grants can be revoked without a lockout (`grant_lockout`, SPEC.md:1097-1139).
4. **Responders must be persons.** If the jockey is the only person, every human decision waits for one human. D6 says a human is never the bottleneck; the design keeps humans out of the routing path and uses attention only for the exceptions the jockey must see. This is a consequence to watch, not a contradiction.
5. **Senders of mail need `label`.** A post that carries labels needs `label` as well as `post` in the channel (`packages/board/src/server/writes.ts:164-182`), and `label` in a channel also lets its holder relabel any message there (`packages/board/src/server/writes.ts:113-121`; there is no per-key rule). So any principal that may post labelled mail can flip `swarm.state` on other mail in that inbox. This design closes it without a board change: the sender posts the block with no labels and the secretary service, the only `label` holder in an inbox channel, writes `swarm.class`, `swarm.urgency` and `swarm.state` from the block as its first step on arrival. Plan 6.1 reads as if the sender sets the labels; [swarm mail](swarm-mail.md#open) carries the same finding. WP-201 settles it. If core wants sender-set labels, the board needs a per-key label rule, which is a larger addition than A1 to A4 and is not designed here.
