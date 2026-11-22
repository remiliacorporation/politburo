status: proposed
bonklek decides on this PR

# Work items and outcomes

A work item names one logical outcome and links the evidence that describes it.
The repo board (work board) shares one queue across parties; the party (Party) that takes a claim has until its hard end, on the board's clock, to prove a listed outcome.
The queue shows who acts next, not the party's score (D19 to D21, plan 6.4).

## Work item

| Field | Meaning |
| --- | --- |
| `work_id`, `repo` | Logical work id and stable repo identity. The id is `<tag>-<number>`, for example `plb-482`. Input is case-insensitive, display is lowercase, and numbers are never reused. Old ids stay valid in history (D14, plan 12 item 7). |
| Title, kind, priority | Human-readable title, `code`, `research`, `report` or `ops`, and queue priority. |
| Links | Every external item, branch, PR and evidence object that describes the work. Use an explicit association or a stable source reference. Never infer a link from a similar title. |
| Source observations | Source identity and revision, state, observation time and freshness. Preserve conflicts and overlap evidence. Configured source precedence resolves tracker disagreements; Git and GitHub are ground truth for branches, PRs and checks (D7, D9, plan 6.5). |
| Claim and claim history | Current party, claimant, attempt, board-issued claim fence, start, deadline and short lease. Retain releases, validated outcomes, docks and overrides with provenance. |
| Spend coverage | Reference to the accounting projection with known totals, reservations and unknown counts. See [spend ledger](swarm-spend.md). |

External ids are typed aliases, scoped by source and workspace or repo. They do not replace the work id. Show source badges such as `GH#812`, `LIN ENG-123` and `bd rw-4u5`. Remilia World's bead ids keep `rw-`; the repo tag cutover does not rename its beads (plan 12 item 7). Its adapter remains read-only (plan 6.5).

Today a task is a thread with state on its root in the reserved `board.task` label (`packages/board/src/contract/schemas.ts:11`, `packages/board/src/contract/schemas.ts:14`, `packages/board/src/contract/folds.ts:263`, `packages/board/src/contract/folds.ts:265`). The create path appends `task.created` with a new root, or attaches the event to an existing thread (`packages/board/src/server/tasks.ts:588`, `packages/board/src/server/tasks.ts:618`, `packages/board/src/server/tasks.ts:723`). See [task semantics](../SPEC.md#tasks).

Design choice: put the work id and kind in filterable labels, with source links, observations, contract results and spend coverage in blocks, so the work projection does not need new board task states. The contract itself lives in the ticket description. Labels and observations do not grant a claim. Use [board additions](swarm-board-additions.md) for the server enforcement boundary.

The mirror records every PR, branch and issue (plan 6.5). Observing an issue is not linking it: a link needs an explicit association or a stable source reference. Work from outside the product (Politburo) appears as an observed row without a party or swarm claim. Show the external actor and evidence where known. An explicit or stable link can associate it with an existing work item. A conflict with an active attempt goes to Repair or reconcile, with the evidence for both sides. An external merge does not award party points or change tracker disposition on its own.

## Outcomes contract

The ticket description carries a versioned Markdown block (`linear-inspiration.md`, “Four-hour acceptable-outcomes contract”; plan 6.4). The following ticket can satisfy its claim with a qualifying PR or a qualifying report.

```markdown
## Acceptable outcomes
<!-- politburo-outcomes:v1 -->
- [ ] kind: pull_request
      repo: acme/web
      base: main
      state: open_or_merged
      checks: required_pass
      evidence: url
- [ ] kind: report
      location: docs/research/retry-cap.md
      required_sections: [findings, recommendation, sources]
      evidence: path

## Verification
- completion_rule: any_outcome
- reviewer: jockey
- on_no_match: release_and_dock
```

| Outcome kind | Evidence the validator checks |
| --- | --- |
| `pull_request` | Canonical PR URL and source-observed repo, base, state and checks. Match the attached candidate and attempt, not the URL string alone. |
| `report` | Declared file path or evidence reference, immutable revision or digest, required sections, and review by the jockey or a named reviewer. No PR required. |
| `research` | Design choice: a revisioned findings artifact with scope, sources and the required findings or recommendation, plus reviewer acceptance. This lets a research ticket prove its result without requiring publication or a commit. |
| `ops` | Design choice: a durable receipt from the target system or an evidence package with the declared verification result, scoped to the operation and accepted by the reviewer. This lets ops prove the change without a fake PR. |

1. Every listed outcome has a stable `kind`, explicit criteria and a verifiable evidence type. Non-code work has proof and review by the jockey or a named reviewer (D12, WP-408).
2. `completion_rule` is explicit and normally `any_outcome`. Regardless of the ticket's downstream completion policy, any one listed outcome that validates on time satisfies the D20 claim. A PR outcome states whether open is enough (`open_or_merged`) or merge is required; check its declared conditions for the exact candidate. Claim satisfaction and review, acceptance or publication are separate decisions.
3. The validator records its result, evidence URI or path, validation time and verifier version for the contract revision and claim attempt. It records the actor and required reason for any human override. Neither prose nor a later override silently backdates validation.
4. An absent, malformed or unverifiable contract means `outcome_contract` is invalid and the item is not claimable. Route it to Needs you until fixed. “Work on it” is not an acceptable outcome. A person repairs the contract or explicitly marks the ticket manual-only, which keeps it out of automated admission.
5. A validator function in `packages/swarm` parses the description and checks the evidence. The board stores the block, not the parser. J9 asks “is the ticket's outcomes contract complete?” at the door, in shadow first (plan 6.3, WP-205 and WP-401). Its classification does not replace validation or authorize a claim.

The validator writes one `outcome-record@1` per check, a block on the work item's thread, so history is a list of them (plan 12 item 10: party and outcome records exist from Phase 1):

| Field | Meaning |
|---|---|
| `work_id`, `party`, `attempt` | What was checked and for whom. `party` is the claiming party's id. |
| `contract_revision` | The message revision of the contract that was checked. |
| `outcome` | The listed outcome that matched, by kind and index, or null for no match. |
| `result` | `valid`, `invalid` or `unverifiable`. |
| `evidence` | Evidence URI or path, and the revision or digest the validator saw. |
| `checked_at`, `verifier_version` | Board-clock time and the validator's version. |
| `override` | Null, or `{ actor, reason }` for a human override. |

## Claim rule

1. A party's **dispatcher** makes the claim. It is the party's model-free service on the Mac Studio and its principal, with the jockey's, is the only one with `label` in `work/` (the starting grants for projects and apps are revoked on a swarm board; see [board additions](swarm-board-additions.md#method)), so the board's `claim.actor` names the party. Cloud mobs never reach a board (D4). The hard end is the claim time plus `claims.hours`, read from the repo board's clock (the lease `until` the board returned, minus the lease asked), never from a party host clock (D20, plan 6.4 and 12 item 4). The party gets an exclusive attempt under a board fence, not proof that a mob is running. A separate [spend reservation](swarm-spend.md) must be confirmed before launch.
2. The board's normal short lease still applies. The dispatcher renews it for as long as the mirror shows the mob alive, so a dead mob is visible before the hard end. Today the board sets lease expiry from `Date.now()`, tests it for lapse and extends it from now on renewal (`packages/board/src/server/tasks.ts:377`, `packages/board/src/server/tasks.ts:109`, `packages/board/src/server/tasks.ts:845`, `packages/board/src/server/tasks.ts:850`), up to 3600 seconds per renewal (`packages/board/src/server/tasks.ts:21-22`). A lease is at least 30 seconds (`packages/board/src/server/tasks.ts:21`), so near the hard end the dispatcher stops renewing and the claim runs at most 30 seconds past it.
3. If a listed outcome validates before the hard end, the claim is satisfied and no further claim clock runs. The dispatcher settles the board claim in the same step: it holds the task with `block` of kind `review`, which ends the claim and makes the task refuse further claims (`packages/board/src/server/tasks.ts:881-895`, `packages/board/src/server/tasks.ts:364`). A claim that was merely left to lapse would read as ready and let another party take it (`packages/board/src/server/tasks.ts:107-112`). The reviewer's acceptance completes the task; a rejection lifts the hold and the task is ready again. Satisfaction does not by itself mark the ticket Done or bypass a review gate.
4. If no listed outcome validates before the hard end, the dispatcher stops renewing, the board expires the lease on its own clock within one lease and the ticket is ready again, and the swarm layer records the miss as a dock against the party. That party's dispatcher refuses its own reclaim until the cooldown ends. Other parties can claim as soon as the board shows the task ready, if the other admission gates pass.
5. No downtime pauses the clock. If the dispatcher is down, renewals stop and the board expires the lease: the claim ends early, never late. On restart the dispatcher reads the board and records the miss for any claim whose hard end passed. The plan has no waiver; whether the jockey may waive a dock after an outage is a question for a person, under Open.

Defaults from `claims` in [party configuration](swarm-party-config.md): `hours: 4`, `reclaim_cooldown_minutes: 15`, `open_claims_per_repo: 2`, `uncommitted_claims_per_repo: 1`, `dock.missed_claim: 1`. Downtime never pauses the clock (D20, plan 4 and 6.4).

| Claim state | Meaning |
| --- | --- |
| `ready` | No active claim; the work may be taken if current admission permits. |
| `claimed` | One current fence with an unexpired short lease and hard deadline. |
| `satisfied` | A listed outcome validates on time and ends the claim clock. |
| `released` | The fence no longer holds the ticket. Preserve the release reason and history. |
| `docked` | A hard miss attaches a dock to the party and claim, not a lock against everyone. |
| `cooling` | That party cannot reclaim the item until the board's cooldown expires. |

These describe the claim and its consequences, not new `board.task` states. A released item can be ready for another party while the first party is cooling.

| Board time, using defaults | Same work item |
| --- | --- |
| 09:00 | Claim starts. Deadline is 13:00. Short renewals do not shift it. |
| 11:20, satisfied path | A listed outcome validates. Clock ends; evidence can still require further review. |
| 13:00, miss path | No validated outcome. Release and dock. Another eligible party may claim immediately. |
| 13:15, miss path | First party is eligible to try again if the item is still available and current admission passes. |

> Plan D20 and plan 4 win over `work-board-redesign.md` section 4: 15 minutes, not 30; a hard four-hour cutoff satisfied by any listed outcome, not commitment followed by a renewable progress lease; one configured dock per miss, not graded docks.

| Edge case | Result |
| --- | --- |
| Draft PR | A draft alone is not proof. It counts only if the declared PR outcome permits a draft and the attached candidate meets its criteria. It is not Ready to review by default. |
| PR attached after four hours | Keep the late artifact and its attempt history. It does not retroactively satisfy the claim or erase the dock. |
| Non-code work | Validate the declared proof and required review. Do not require a PR. |
| Human or non-Politburo claimant | Outside the party claim protocol, use an observed overlap lock from associated Git evidence, with explicit freshness. It is not a party claim and earns no party score or dock (D7, plan 6.5; `work-board-redesign.md` section 4). |
| Board down | Server time still governs. An artifact timestamp alone is not an on-time validation. Reconcile after recovery and surface any outage dispute. |
| Repeated misses | Each hard miss gets the configured dock and cooldown. No graduated penalty is specified. |
| Claimant releases | Record who released, when and why. Fence the released attempt. Do not record release as satisfaction or treat a fresh claim as a renewal. Early-release accounting remains open. |
| Handoff | Make it explicit, with a recorded recipient and current capacity. A handoff of the same claim preserves the deadline and history (`work-board-redesign.md` section 4). Do not infer acceptance from a branch push. |

What the board enforces itself: one claim per task, the fence, the lease on its clock and its expiry, and refusal of a claim on a held task (`packages/board/src/server/tasks.ts:343-372`). What the swarm layer enforces, as the only claiming principal: the hard end, the claim caps and the reclaim cooldown. A ticket with no valid contract is held with kind `outcomes`, so the board refuses its claim (`packages/board/src/server/tasks.ts:364`). The task's owner is the dispatcher principal, so only its edits change what the task says; an edit by anyone else holds a waiting, ready or claimed task with kind `edited` (SPEC.md:4018-4027). The dispatcher is the task's owner, so it alone places a hold with `block` (`packages/board/src/server/tasks.ts:881-895`) and lifts it with `unblock` (`packages/board/src/server/tasks.ts:969-979`). It holds the task with kind `outcomes` before it publishes a new revision of a contract and lifts the hold only after the validator passes that exact revision. The swarm layer validates outcomes, records docks and computes score. No board change is required; [board additions](swarm-board-additions.md) lists four deferred additions, A1 (a board-held hard end) among them, and the triggers for taking them (plan 3.1, 6.4, WP-402 and WP-701).

## Board groups

Evaluate these rules at one read time, in order. Use the first match. `Open` excludes accepted, done, rejected and canceled work. Empty groups are hidden; Done is hidden by default and visible in history or by filter. Group names are UI defaults from party config (D21, D22, plan 6.4; `work-board-redesign.md`, “Work queue groups”).

| Group | Rule | Primary actor | Default sort |
| --- | --- | --- | --- |
| Needs you | Open with an invalid outcome contract that needs fixing, a current structured human request with decision context, an eligible responder and expiry after the read time, or a policy exception requiring a human. This overrides other open groups. | Jockey or eligible responder | Severity, nearest deadline, oldest first. |
| Repair or reconcile | Open with a tracker changed or canceled outside policy, two active attempts sharing a canonical source, branch or PR, an unreconciled expired claim, stale or missing required run evidence, a changed PR head, terminal CI failure, rejected required review, an unreadable or stale required source needing repair, or an unresolved release or dock dispute. | Owning party first; jockey when policy requires | Severity, oldest broken policy first, then priority. |
| Ready to review | Open with a qualifying current candidate, an open PR or current non-code proof, required CI passed rather than absent or pending, no requested changes or failing gate, and no human hold. A draft does not qualify by default. | Reviewer or jockey under repo policy | Earliest review-ready time, then highest priority. |
| Running | Open with a current valid claim, unexpired short lease and unexpired hard deadline. Earlier groups win. No commitment extends this group beyond the hard deadline. | Claimant or mob view (Cell) | Nearest expiry, stale evidence first, then highest priority. |
| Ready to pull | Open and tracker-eligible, with required prerequisites resolved, no active claim or branch or PR overlap lock, no park, sufficient source freshness, and at least one party that could pass admission in this scope. A valid contract is required. | Any admitted party | Highest priority, earliest tracker-ready time, then stable work id. |
| Waiting or parked | Other open work: unscoped, blocked or deferred in the tracker, waiting for a prerequisite, parked, short of rate or budget capacity, or stale external source without a repair owner. Show the explicit reason. Collapse deferred backlog by default. | Named blocker owner or none | Blocker class, priority, then oldest first. |
| Done | Accepted, done, rejected or canceled. | None | Most recent disposition first. |

Design choice: sort Done by most recent disposition because the research specifies no Done sort. Use the stable work id for ties in any group so refreshes do not reorder equal rows. The shared queue is never sorted by party score (plan 6.7).

The eight old columns are not rebuilt (D21). Default mapping, subject to the new predicates: Backlog → Waiting or parked; Ready → Ready to pull; Needs triage → Repair or reconcile; Agent repair → Repair or reconcile; Started → Running; QA review → Ready to review; Human attention → Needs you; Closed → Done. An imported Started row without a live claim goes to Repair or reconcile, not Running (`work-board-redesign.md` section 5, WP-801).

### Home

Use four short sections in this fixed order (plan 6.4). Unlike the queue groups, the home keeps its headings and says when a section has nothing to show.

| Section | Contents |
| --- | --- |
| Needs you | Validated human decisions first, then policy exceptions. Show question, options, safe default, affected work and deadline. Sort urgent first, then deadline and age. |
| Ready to review | Same predicate and order as the queue group. Show exact candidate head or evidence revision, checks, review state, age and producing party. |
| Running now | Current claims grouped by party and mob view. Show countdown, evidence age, branch or PR, actual model and spend coverage. A lease is not liveness: show `claimed; liveness not confirmed` without fresh run evidence. |
| Health and spend | Per party and repo total: active and limit, expiring and stale claims, review WIP, observed tokens, priced estimate, reserve, unknown count and telemetry age. Drill down to stalls, overlap and source failures. |

## Row and scopes

Use a dense list by default, with optional columns and a detail peek (D21, plan 6.4). Show priority, id, title, party colour and name, claimant or mob view, group reason, claim countdown, PR and check state, spend with coverage, tracker badges and overlap. Colour is never the sole cue. Show relative time with the absolute board time in the title or detail. Unknown spend says `unknown`, never zero or hidden. Show overlap type and its source, not just a warning mark. Detail keeps evidence freshness, head SHA, contract results, claim history and permitted actions.

Plan 6.4 and D8 win over the five-group layout and hidden unknown spend in the Linear research note. WP-404 builds the keyboard and views below. Do not intercept bare keys while typing. Every action that claims, releases or accepts is checked by the dispatcher or the board, not by the key: the key only asks.

| Keys | Action |
|---|---|
| `j` `k` or arrows | Select the next or previous row. |
| Space, Enter, Esc | Peek the row, open the full item, close. |
| `/` | Focus the filter. |
| `g` then a letter | Jump to a group: Needs you, Ready to review, Running, Ready to pull, Done. |
| `[` and `]` | Collapse or expand a group. |
| `o`, `p`, `e` | Open the source, the PR, the evidence. |
| `c`, `x`, `r`, `d` | Ask the dispatcher to claim for an admitted party, release with a reason, request review, accept with evidence chosen. A person never claims as an agent in a browser. |
| `f`, `v`, `?` | Filters, display menu, key help. |
| Cmd or Ctrl `K` | Command menu for every action. |

Saved views are URL-addressable filter and display presets, not separate queues. The starting set is My attention (the default for a person: Needs you and Ready to review for items they own, requested or watch), Repo operations (the shared default), Available, Live claims, Review queue, Exceptions and History. Display controls: list or board, compact or comfortable, group and subgroup, order, visible fields, hide or show empty groups, show closed. Defaults: list, compact, grouped by next actor, no subgroup, empty groups hidden, Done hidden.

| Scope | What it shows |
| --- | --- |
| Party board (Standing Committee) | One party across all repos. Home and spend roll up for that party. Ready to pull applies only to repos it can serve. Link to the shared queues, not copies. |
| Repo view (Presidium) | One party on one repo board, with an all-parties switch. Keep shared queue and overlap context visible. |
| Mob view (Cell) | One mob inside its repo view. Show current attempt, clock, branch or PR, checkpoints, sprites, spend and handoff. It cannot act for other claims. |

## Caps and admission

The dispatcher checks open and uncommitted claims per party per repo against current `claims` config before it claims (plan 4 and 6.4). It counts from the board's claimed tasks, whose `claim.actor` names the party. A mob view does not get a separate allocation. A refusal names the cap and when it may clear, or says that time is unknown. Recheck eligibility, source freshness and overlap against the current read before dispatch. A partial overlap read never clears overlap (plan 6.5). The spend gate is separate from both caps.

Design choice: an uncommitted claim is an open claim with no linked artifact for any listed outcome yet, such as an opened PR or linked evidence object for that attempt. This caps claims with nothing to show without making artifact attachment equivalent to validation. See Open.

## Work packages

| Package | Builds |
| --- | --- |
| WP-401 | Work ids, links, intake and spawner approval or denial, contract validation and shadow J9 at the door. |
| WP-402 | Dispatcher claim clock, release, cooldown and caps over the board's own lease and fence; one winner on racing claims comes from the board. |
| WP-403 | Party registry and grants, party identity on records, and configured names and colours in shared views. |
| WP-404 | Queue, home, rows and peek, filters, keyboard, saved views and three scopes. |
| WP-408 | Non-code outcome evidence and review without a PR. |
| WP-409 | Mirrored mob and sprite status with freshness, and one jockey decision inbox. |

See plan 7, [architecture](swarm-merger.md) and [reuse](swarm-reuse.md).

## Open

| Item | What remains open |
| --- | --- |
| Uncommitted cap | Confirm what artifact qualifies for the proposed definition. Plan 6.4 names the cap but does not define uncommitted. |
| Early release and short lease lapse | Confirm how voluntary release, early lease expiry and a new claim interact with outstanding hard-miss accounting. Neither a voluntary release nor an expired short lease is proof of an outcome. |
| Outage waiver | Confirm whether the jockey may waive a dock or admit delayed validation, and with what evidence. Do not pause or extend the clock. |
| Dock record boundary | Plan 6.4 says the board ends the claim and records a dock. This design lets the board's lease expiry end the claim and has the swarm layer record the dock. Core confirms that reading, or takes A1 in [board additions](swarm-board-additions.md#a1-hard-end-of-a-claim). |
| Plan 10 items 2, 3 and 5 | bonklek supplies the Jev credential and names the decomp research board owner. Charlie agrees to the read-only beads view and how claims are shared with his workers. Each blocks only the work named in plan 10. |
