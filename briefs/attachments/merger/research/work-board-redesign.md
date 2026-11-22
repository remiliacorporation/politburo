# Shared repo work board redesign

## Summary

Build one **shared, repo-scoped work board**. It is a dense grouped list by default, not a status-column wall. Its first groups answer, in this order: **Needs you**, **Ready to review**, **Running now**, **Health and spend**. Below them is the work queue, grouped by the *next actor and decision*, with empty groups hidden. Kanban is an alternate diagnostic view, not home.

Keep two facts separate everywhere:

- A tracker owns its issue fields and workflow when the repo is configured for an external tracker. Politburo owns dispatch, claims, attempts, evidence, attention, spend and the links between records.
- Git and GitHub are observed ground truth for branches, commits, PRs and checks. They can advance an evidence projection, but do not silently rewrite a tracker or claim.

### Ranked recommendations

1. **Use one canonical `work_item` per logical outcome and many immutable links.** Links cover native task, Beads, Linear, GitHub Issue, PR, branch and evidence. Do not mirror each tracker as a second editable task.
2. **Make the default view an action-first grouped list.** Use six mutually exclusive work groups: Needs you, Review, Repair/reconcile, Running, Ready, Waiting/parked. Keep Done out of the default and hide empty groups.
3. **Use a four-hour claim as an admission proof, not a four-hour work limit.** A claimant must create a verifiable commitment before expiry: a qualifying PR plus a meaningful lifecycle progression, or declared non-code proof. Thereafter use short progress leases and an ageing policy, not automatic punishment for slow work.
4. **Show provenance and uncertainty on every row.** Party, actual claimant, expiry, PR/check state, evidence, spend coverage, tracker links and overlap are first-class fields. “Unknown” must never render as green or free.
5. **Enforce party capacity before claim.** Start with a per-party open-claim limit and a per-repo review WIP limit. Capacity is shared across a party’s Presidiums; a Cell cannot bypass it.
6. **Preserve a human jockey lane without making it the default bottleneck.** Put only decision-ready, genuinely human-only requests in Needs you. Give the jockey pause, park, unpark, reassign, budget and override controls; never use “human attention” for agent repair.

## Evidence and scope

Read locally: Tigeryard `board/projection.py`, `attention.py`, `blockers.py`, `gates.py`, `priority.py`, `reviews.py`, the requested server/UI sections, README and frontend/cutover documents; Politburo’s requested design and inspector files; advisor notes; and merger research. I also read Tigeryard PR 20 metadata and its first 400 diff lines with `gh` on 2026-11-21. No repository was changed and no tests were run.

The external-product observations below are documented-product behaviour, not a claim about a vendor’s internal consistency, cost accounting, or idempotency. “Unverified” identifies a useful but not independently confirmed claim.

## 1. Tigeryard as it is

### Exact column projection

`issues.state` has these 16 values:

`proposed`, `scoped`, `authorized`, `ready`, `claimed`, `working`, `handoff_ready`, `qa_ready`, `qa_running`, `repair_needed`, `blocked`, `paused`, `review_ready`, `approved`, `done`, `rejected`.

The projection is ordered and has precedence. It is not a workflow transition.

| Priority | Column | Exact rule |
|---:|---|---|
| 1 | Closed | `state ∈ {approved, done, rejected}`. Nothing can overlay a terminal state. |
| 2 | Backlog | Open issue is operator-parked. This overrides its ordinary state and suppresses Human attention. |
| 3 | Human attention | Open issue has a current, unexpired attention requirement whose kind is one of `user_decision`, `approval`, `credentials`, `external_action`, and whose reason passes the strict decision-form validator. This overrides every ordinary open-state group. |
| 4 | Needs triage | State is unrecognised, **or** `state ∈ {repair_needed, blocked, paused}` and either owner or controller is absent. |
| 5 | Agent repair | `state ∈ {repair_needed, blocked, paused}`, with both owner and controller present. |
| 6 | Backlog | `state ∈ {proposed, scoped}`. |
| 7 | Ready | `state ∈ {authorized, ready}`. |
| 8 | Started | `state ∈ {claimed, working}`. |
| 9 | QA review | All remaining classified open states: `state ∈ {handoff_ready, qa_ready, qa_running, review_ready}`. |

The declared visual order is Backlog, Ready, Needs triage, Agent repair, Started, QA review, Human attention, Closed. Thus the precedence above is not the display order.

Two important details prevent misleading readings:

- **Started is not live execution.** Both lifecycle states `claimed` and `working` display as “Started”. “Working” is a separate label only when the newest accepted supervisor receipt matches exact owner, agent generation, assignment generation, provider session, operation, lease and active network generation; it must be within the role TTL and before lease expiry. Newer stale, terminal or mismatched evidence defeats older running evidence. No receipt, stale receipt, paused network, missing identity or expired lease cannot produce Working.
- **Human attention is deliberately narrow.** A reason must include ordered, nonempty Question, Context, Options, Evidence, Impact, Actor, Why human, Channel and Release sections, at least two labelled options, a human actor, and proof that only a human can act. Infrastructure failure, an expired lease, bad tests, quota, stale evidence and missing ownership are rejected as agent-actionable, not escalated.

Sources: `board/server.py:974-1065,1584-1628`; `board/projection.py`; `board/attention.py`; `board/README.md`, “Started cards and execution evidence”, “Board column order”, “Human attention versus agent repair”.

### What a Tigeryard board card shows

Every kanban card shows issue key, lane, title, displayed lifecycle state, priority, owner, controller, and sometimes a blocker. It has these group-specific additions:

- Needs triage: a concise reason, either missing owner/controller or unrecognised state.
- Agent repair: controller/owner grouping, blocker/repair reason and source.
- Started: the evidence-derived execution label, and where available run/operation ID, source, observation and freshness information.
- Human attention: the full recorded human-action reason.
- Closed and QA: still display the underlying state; columns do not prove acceptance or publication.

The issue detail page adds scope, messages, responsibility, candidate/evidence gates, execution detail, blocker explanation, attention response and audit history. The separate review queue only considers scheduler `pipeline_stages` and `execution_attempts`; it is not the same projection as QA review.

### What was good

1. **It distinguishes stage, liveness and authority.** Started is not “running”; live status requires fresh exact evidence. This is stronger than most task boards and should survive the rebuild.
2. **It makes the human queue explicit and restrictive.** A repair cannot hide as “waiting for a human”. This matches the intended jockey role.
3. **It preserves explanations.** Triage, blocker, ownership and source are present rather than a traffic-light-only board.
4. **It treats evidence as candidate-bound.** Submission, tests and review gates are separate; a passed pipeline row is not a passed gate. It also has a non-code manifest/evidence route.
5. **It has useful compact interaction foundations.** Search, lane and priority filters, keyboard navigation, contextual column menus, shareable focus, local collapse state and draft-safe refresh are sound patterns.

### What was bad

The advisors found a serious mismatch between this well-specified issue board and the operator’s actual work:

- It is a single-project issue surface. It does not represent parties, spawners, mobs, sprites, tracker authority, Git/PR overlap, token usage, budgets, active claims across parties, or an actionable owner inbox.
- Its first screen begins with fourteen metric tiles, a 46-choice lane filter and Backlog. The reviewed Remilytics instance opened with 67 mostly deferred/unassigned cards and rendered roughly 780 card elements. This answers neither “what is moving?” nor “what needs me?”.
- Its Review page can say zero while the board has QA work because it reads removed-scheduler tables rather than the QA projection. That is a trust failure, not an empty state.
- Stale agent health is presented too prominently. The advisor observed old agents and many “need attention” flags, weakening trust in every live claim.
- Eight fixed columns conflate two purposes: lifecycle reporting and next action. The Human attention overlay helps, but agent repair, stale claim, missing Git evidence and review readiness are still dispersed.
- The 15-second full re-render is expensive and, despite safeguards, is inferior to event-driven update for a dense operational home.

Sources: `advisor-tigeryard-ux-2026-11-21.md`, findings 1, 4, 5, 7 and 10; `docs/frontend-review.md`.

### PR 20: Dense grouped issue list as board home

PR 20 is open: [“Dense grouped issue list as board home”](https://github.com/bonklek/tigeryard/pull/20). It makes the list the default and retains `?view=board` for kanban. Its proposed list order is Needs you, Started, Agent repair, Needs triage, QA review, Ready, Backlog, Operator blocked, Done. Empty groups are skipped. A wide screen opens issue detail beside the list. It compresses metrics to links and uses list rows with key, title, priority, inferred model/provider family, state and a short action/reason.

**Good direction:** list-first; action-first grouping; empty groups suppressed; a separate parked group; compact summary; details without losing list context; responsive and print consideration. It directly responds to the owner’s stated dense Linear-style preference and the advisor’s “grouped list as default” recommendation.

**Problems to avoid copying:**

- It still derives groups from the old single-board columns. “Started” remains more prominent than a real review queue, claim expiry, overlap or external PR state.
- It reduces visible ownership to a model/provider family. A shared board needs the accountable party, claimant and Cell, not “Sol” or “Haiku”.
- It does not introduce party capacity, claim compliance, multi-tracker links, cost/coverage, Git/PR reconciliation, or non-Politburo actors.
- The PR description says no visual QA and no deep review sprite were completed. Treat it as a useful layout experiment, not settled evidence.
- Hiding empty groups is right for home, but deep-linkable diagnostic groups and explicit zero/error states remain necessary when a filter is active or a data source is unavailable.

## 2. State of the art and the relevant lessons

### Product patterns

| System | Documented behaviour | Useful lesson |
|---|---|---|
| Linear agents | Linear keeps the issue and its workflow while agent sessions report run activity. [Linear agent docs](https://linear.app/developers/agents); [Linear for agents launch](https://linear.app/changelog/2025-05-20-linear-for-agents). | Separate human/accountable issue state from one or more agent runs. A run is not ownership of the issue. |
| GitHub Copilot coding agent | GitHub describes background work from an issue, session activity and a PR for review. [GitHub blog](https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/); [current cloud-agent docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent). | A PR and review are distinct from assignment. Show the session/run and the PR as separate linked facts. |
| Devin | Linear integration supports delegation triggers, session/follow-up context and PR links. [Devin Linear docs](https://docs.devin.ai/integrations/linear). | Prevent a persistent label or matching condition from launching repeated work. Store a logical run id and dedupe trigger delivery. |
| Factory | Factory documents delegation from Linear through an organisation Agent Profile. [Factory Linear delegation](https://docs.factory.com/delegations/linear). | Execution identity should be a repo-capable organisational actor, not a person’s personal connector. |
| Cursor | Cursor documents Linear-linked agent work and repo routing/status. [Cursor Linear docs](https://cursor.com/docs/integrations/linear). | Repo selection, run status and PR are essential row facts. Do not make a user infer them from a title. |
| Codex | Codex documents running cloud tasks and review of results; its Linear integration continues work in a linked chat. [Codex Cloud](https://developers.openai.com/codex/cloud/); [Codex in Linear](https://learn.chatgpt.com/docs/third-party/linear). | Preserve conversation/session identity for continuation, but do not make chat state the work authority. |
| OpenHands | Its GitHub integration is explicitly trigger-to-PR/comment oriented. [OpenHands GitHub installation](https://docs.openhands.dev/openhands/usage/cloud/github-installation). | External agent work can enter through GitHub without using Politburo; represent it as observed work, not an unowned foreign object. |
| Gas Town / Beads | Beads keeps durable issue/dependency memory; Gas Town layers orchestration on it. [Gas Town launch](https://yegge.ai/essays/welcome-to-gas-town/); [Beads coordination](https://github.com/gastownhall/beads/blob/v1.3.4/docs/multi-agent/coordination.md). | One durable tracker can own task semantics while a separate system owns fleet dispatch. Do not clone the backlog just to schedule agents. |
| Claude Code teams | Teams coordinate shared tasks and explicitly warn that multiple teammates multiply token use. [Agent teams](https://code.claude.com/docs/en/agent-teams.md). | A board needs fan-out, active-run and spend limits, not merely task status. |
| Vibe Kanban | Public claims should be treated as **unverified** here; the site did not return usable documentation in this research. | Do not use marketing screenshots as policy evidence. A local list/board switch is easy; correct claims and evidence are the hard part. |

The cross-product norm is not eight lifecycle columns. It is an issue/task record with a separate execution-session surface, visible PR/review evidence, and a human approval point. Products often show a run state such as queued/running/needs input/completed beside workflow status. They rarely solve multi-party ownership, source-of-truth conflicts or exact spend; Politburo must.

### Kanban practices that matter

- **Pull, not push.** A party may claim only work that passed readiness checks and capacity admission. It cannot fill capacity by inventing work.
- **Explicit policies.** Claim qualification, expiry, renewal, PR attachment, proof for non-code work, tracker precedence and review readiness must be written next to the relevant group. Hidden conventions create false green cards.
- **WIP limits.** Limit active claims per party and review-ready items per repo. A limit exposes bottlenecks instead of rewarding claim hoarding. [Atlassian’s WIP guide](https://www.atlassian.com/agile/kanban/wip-limits) is a concise general source.
- **Age, not colour alone.** Display claim age, time in current group, time since meaningful evidence, review age and stale-data age. Sort old actionable work before newer routine work within the same priority.
- **Cycle time and flow.** Record timestamps for ready, claim, qualifying commitment, review-ready, merged/accepted and done. Report percentile cycle time and age distribution by repo/party/task type; do not use an average alone.
- **Swimlanes only when they change action.** Party is a filter and small row mark, not eight party columns. Use a temporary “overlap” lane only for collisions. Excessive swimlanes recreate the horizontal-scroll problem.

## 3. Proposed shared repo work board

### Data model and authority

A repo has exactly one board. A `work_item` is the stable logical outcome. It owns:

- `work_id`, repo identity, title, type (`code`, `research`, `report`, `ops`), priority, created/updated times;
- board disposition and lifecycle; active claim and claim history; party/Cell/run identities;
- links: zero or more external items, Git branches, PRs, commits, reports and evidence objects;
- source observations with observed time and freshness; conflicts and overlap detections;
- spend reservation, observed usage roll-up, coverage state and human-attention accounting;
- append-only claim, release, dock, state and override events.

A `tracker_link` has provider, stable remote identity, display id, URL, observed revision/state, observed time, authority mode and link role (`primary`, `duplicate`, `relates`, `blocks`, `describes`). Multiple links can describe one work item. The repo configuration chooses one work-tracker authority: `board`, `beads`, `linear` or `github`. In external mode, the adapter owns title, scope, tracker status, assignees and dependencies. Politburo owns all dispatch facts. Git/GitHub are evidence authority for commits, branches, PR state and checks.

Never infer a link from title similarity. Link creation needs an explicit operator/adapter association or a stable source reference. External changes can make an active run need rebrief or stop further dispatch; they do not erase its historical attempt or silently claim it for another party.

### Default home: four fixed operator sections

These sections have fixed order. Each is a short, dense table. Show “nothing …” when empty, not a decorative card.

1. **Needs you.** Current validated human decisions, then policy exceptions requiring the jockey: budget override, ambiguous external conflict, expiry dispute and irreversible publication. Sort P0/P1 first, then decision deadline/age. Each row includes the question, options, recommendation/safe default, affected work, expiry and one action. An agent failure never enters this section merely because it is inconvenient.
2. **Ready to review.** Current candidates with a PR or non-code evidence package that satisfies the repo’s review-entry rule. Sort oldest review-ready first, then priority. Show exact head, CI/check state, independent-review state, review age and which party produced it. This is the one review queue; it must not disagree with a board group.
3. **Running now.** Live or plausibly active claims. Group by party, then Cell. Show claimant, Cell/run, claim countdown, last evidence age, branch/PR, actual model, spend and coverage. “Working” needs a fresh source; otherwise say `claimed; liveness not confirmed`.
4. **Health and spend.** One narrow line per party plus repo total: active/limit, expiring claims, stale claims, review WIP/limit, observed tokens, priced estimate, reserved budget, unknown usage count and telemetry age. Expand for a table of stalled loops, open overlaps, source failures and provider constraints.

A compact header above these has only counts/links: needs you, review ready, running, claims expiring in 30 minutes, and spend versus limit. It is not a dashboard of tiles.

### Work queue groups

Below the home sections, the same work rows appear once in one mutually exclusive group. This is the exact projection, evaluated in order at one read timestamp `now`. `open` means neither canceled/rejected nor accepted/done.

| Group | Exact rule | Primary actor |
|---|---|---|
| Done | `lifecycle ∈ {accepted, done, rejected, canceled}`. Default-hidden; visible by filter/history. | none |
| Needs you | `open` and there is a current structured human request with required decision context, an eligible responder, and `expires_at > now`; **or** a policy exception has `requires_human=true`. It overrides all other open groups. | jockey |
| Repair / reconcile | `open` and any of: external tracker changed/canceled outside policy; two active attempts link the same canonical source/branch/PR; a claim has expired; claimed run has stale/missing required evidence; PR head differs from attached candidate; CI has terminal failure; required review is rejected; required source is unreadable/stale; or a release/dock dispute is unresolved. | owning party first; jockey only when policy says so |
| Ready to review | `open`, qualifying submission/evidence exists for current candidate, associated PR is open or non-code proof is current, required CI is passed (not absent/pending), no requested changes/failing gate, and no current human hold. A draft PR does **not** qualify by default. | reviewer/jockey according to repo policy |
| Running | `open`, active claim is unexpired, no Repair/Needs-you condition, and claimant has attached a qualifying commitment or remains inside the initial four-hour claim window. Display `live` only with fresh run evidence; otherwise `claimed; not confirmed`. | claimant party/Cell |
| Ready to pull | `open`, tracker state is eligible under repo policy, all required external/native prerequisites are resolved, no active claim, no active branch/PR overlap, no park, source freshness is within policy, and party admission could succeed. | any admitted party |
| Waiting / parked | All other open work: not yet scoped, tracker says blocked/deferred, prerequisite pending, intentionally parked, rate/budget capacity unavailable, or external source stale without a repair owner. Subgroup by explicit reason; never call it “ready”. | named blocker owner or none |

This replaces Tigeryard’s Backlog/Ready/Needs triage/Agent repair/Started/QA/Human attention/Closed display. The key change is moving from a mostly lifecycle-shaped board to action and proof. “Needs triage” becomes Repair/reconcile with a reason and owner. “QA review” becomes one precise Ready to review predicate. “Started” becomes Running with liveness confidence and claim deadline. Backlog is a collapsed Waiting/parked subgroup, not the landing screen. Closed is default-hidden. Human attention keeps precedence and strict validation.

#### Default grouping and sort

- Home sections: fixed order above.
- Queue group order: Needs you, Repair/reconcile, Ready to review, Running, Ready to pull, Waiting/parked, Done.
- Within Needs you: severity, deadline, age.
- Repair: severity, broken-policy age, priority.
- Review: review-ready age ascending, priority descending.
- Running: expiry urgency ascending, stale-evidence first, priority descending.
- Ready: priority descending, tracker-ready time ascending, then stable `work_id`.
- Waiting: explicit blocker class, priority, age. Deferred/default backlog is collapsed.

Do not sort a shared queue by party score. It rewards gaming and hides urgent work.

### The dense row

One row, with a detail pane on wide screens. Every row has:

`priority · work id · title · party colour/name · claimant/Cell · group/reason · claim countdown or age · PR/check · spend · tracker links · overlap`

Required display rules:

- **Party:** a 2–3px colour rule and text party name. Colour is never the sole cue. Unclaimed is `—`; observed external work is `external` with the discovered actor/branch where known.
- **Claim:** `2h 14m to commitment`, `committed 38m ago`, `expires in 22m`, `expired 12m ago`, or `released`. Countdown is relative; absolute server time is in title/detail. Never use the party host clock.
- **PR/check:** `PR #42 draft`, `PR #42 open · CI pending`, `PR #42 · CI fail`, `PR #42 · checks pass · review needed`, `no PR`, or `evidence package`. A PR label links to the canonical host URL and includes head short SHA in detail.
- **Spend:** observed tokens by bucket when available; priced estimate separate from provider/settled charge; `reserved`; and coverage `complete`, `partial`, `unknown` or `stale`. Unknown is explicit, never zero.
- **Trackers:** compact source badges such as `bd rw-4u5`, `LIN ENG-123`, `GH #71`, `native`. Multiple badges link to their sources; the primary authority badge has a small `source` label.
- **Overlap:** show `overlap: branch`, `overlap: PR`, `overlap: tracker item`, or `possible overlap` with evidence and observed time. Do not merely show a warning icon.
- **Why blocked:** a short first line in the row; full current source/reason, next owner and last change in detail.
- **Age:** show age of current group and evidence freshness when they differ. A long-running task with fresh checkpoints is not identical to a silent task.

Detail adds source snapshots and timestamps, full tracker-link set, claim/dock history, attempt tree, live evidence, PR/check history, immutable proof/evidence, spend provenance, attention decision, and actions permitted to the viewer.

### Non-Politburo PR or branch

A Git/GitHub reconciler finds a PR/branch even if no board task initiated it. It creates an **observed work record** only after a stable association exists: an external issue link, explicit branch/PR metadata, or operator association. It does not claim the work for a party.

The row reads, for example:

`P2 · GH-71 improve parser · external · unclaimed · PR #914 open · CI pending · 0 observed / unknown spend · GH #71 · overlap: native W-318`

If it matches an existing work item, attach the PR as evidence and show `external contributor` as the producing actor. If it conflicts with an active Politburo attempt, move the item to Repair/reconcile, freeze new claims, show both branch/PR identities and ask the owning party to adopt, supersede, split or abandon. A merged external PR is an observed integration fact; it does not close an external issue or award party points until the configured completion policy is satisfied.

### WIP and open-claim limits

Use admission limits, not visual nagging:

- `party.open_claims <= min(party_configured_limit, currently healthy workers, budget/concurrency capacity)`. Initial default: 2 per party per repo; tune with observed flow.
- `party.uncommitted_claims <= 1` per repo. This directly limits four-hour claim hoarding.
- `repo.review_wip <= configured reviewer capacity`; default 3. When full, a completed worker may hand off evidence but its item remains Running/awaiting review admission, not falsely Ready to review.
- Optional type limits: one risky migration or one production ops task per party/repo.
- Global/repo spend, provider quota and human-attention capacity are gates. An admission refusal explains which cap and when it may clear.

A party’s limit is shared across its Presidiums; a Cell view is a subset and cannot claim above the party allocation. Operators can grant a short, audited exception. Capacity excludes stale/expired claims after reconciliation; it does not assume a process is live because a claim exists.

### Filters and keyboard use

Keep one type-ahead command/filter field. Filter chips include repo, group, party, Cell, claimant, tracker/provider, source status, priority, tag/type, PR/CI/review, claim state/expiry, overlap, spend coverage, evidence freshness and age threshold. Saved views are URL-addressable and read-only.

Keyboard:

- `/` focuses filter; `j/k` moves row; Enter opens detail; `o` opens external source; `p` opens PR; `e` opens evidence; `r` opens review queue.
- `g n/r/u/w/q` moves among Needs you, Review, Running, Ready, Queue. `[`/`]` collapses/expands a group. `?` shows keys.
- `c` claims only for a permitted agent/party after a confirmation summary; people do not impersonate an agent in a browser. `x` parks/unparks where permitted. `a` answers attention only for an eligible human responder.
- No key silently transitions workflow, spends budget, overrides a gate or opens a provider session.

Follow inspector invariants: state is in the pure store; all board access flows through `app/board.ts`; open detail is in the URL; live updates do not move reading position or overwrite composition; content is in the sidebar and configuration in settings; text links navigate and buttons act; no smooth scrolling or decorative effects.

### Same facts at three scopes

- **Standing Committee:** party-wide, cross-repo view. The four home sections show that party’s claims and score; Ready to pull is filtered to repos the party may serve. The shared queues remain repo-scoped links, not copied queues. Health/spend rolls up party own/inclusive usage and limits.
- **Presidium:** one party plus one repo. It opens on the shared repo board filtered to that party, with an adjacent `all parties` switch. The common queue and overlap rows stay visible, because hiding competitors recreates collisions. Party capacity and score context are shown in the header.
- **Cell:** one mob. It is a narrow execution view: current attempt, claim clock, branch/PR, checkpoints, sprites, spend and next handoff. It cannot declare a task unblocked or manipulate other parties’ claims. Its parent Presidium is one click away.

## 4. The four-hour claim policy

### Recommended precise definition

A claim is a fenced, server-time interval granting one party exclusive right to start an attempt on one `work_id`. It is not proof that a process runs, authority to change an external tracker, or a promise that the entire work completes within four hours.

**Admission.** A claim succeeds atomically only if the item is Ready to pull, the party is below every applicable cap, no active claim/overlap lock exists, the current work/tracker revision matches the claimant’s snapshot, the board is not paused, and a budget/concurrency reservation succeeds. Store party, Cell/attempt, actor, claim generation, server-issued opaque lease token hash, `claimed_at`, `commitment_due_at = claimed_at + 4h`, and initial source revisions.

**Qualifying commitment before `commitment_due_at`.** The claimant must record both:

1. a meaningful state progression from the captured ready state to `in_progress`/`submitted` in the execution projection, with a current attempt/checkpoint; and
2. one qualifying artifact for the same attempt:
   - **code:** attached PR URL plus head commit and expected branch. By default it must be an open, non-draft PR. A repo may explicitly allow a draft as an early commitment only if it also has a pushed head and required branch metadata; draft alone does not count.
   - **non-code:** a declared outcome target and immutable proof package, with scope, producer, timestamp, artifact locations/digests and verification predicate. “I researched it” is not proof.

The server/reconciler validates the attached reference, repository, branch/head and source time. It does not accept a URL string as proof.

**After commitment.** The initial claim becomes a renewable execution lease. It has a default 60-minute liveness/progress renewal cadence, but not a new four-hour grace period. Renew requires the same party, current claim generation, current policy/budget admission and either fresh verified execution evidence, a changed candidate/PR/check state, or an explicit blocker checkpoint. A renewal with no new evidence is refused after one grace renewal. The row displays the next renewal due and evidence age.

**Completion.** PR merge/close, CI, tracker transition and evidence gates are separate events. A merged PR does not by itself release or score the work; configured completion evidence does. A failed CI or review changes group to Repair/reconcile, but the party can retain its claim while it actively repairs and remains inside lease/progress policy.

### Edge cases

| Case | Policy |
|---|---|
| Draft PR | Not a qualifying commitment by default. Allow only an explicit per-repo draft policy with pushed head and binding to the attempt; display `draft commitment`, not review ready. |
| “State change” | A meaningful, auditable projection transition from ready to active/submitted for this claim generation. Updating title, priority, labels, a comment, or toggling state back and forth does not count. State change plus artifact are both required. |
| PR attached after four hours | The claim has already expired. Preserve the late artifact and attempt history; do not retroactively avoid the dock. The jockey may waive it only for a recorded board/outage fault or verified source outage. |
| Slow but real mob | It may keep working after a qualifying commitment through renewal/checkpoints. If it has neither commitment nor fresh evidence, release it. Slow is not misconduct; silence is the policy violation. |
| Non-code work | Declare target/proof type at intake. Commitment is immutable proof package plus active state/checkpoint; completion requires configured evidence review. Do not force a fake PR. |
| Human/non-Politburo claimant | A human may reserve with the same party/actor identity or be recorded as `external human`. A Git branch/PR is observed, not a claim, until associated. If the human does not use the board, set an explicit observed-external lock with short TTL from Git evidence; it prevents collision but does not earn party score or create a punitive dock. |
| Board/party-host outage | Server time is authoritative. The board retains expiry even while a party host is down. If the board/reconciler was unavailable, accept verifiable artifact timestamps created before deadline when it recovers, then waive/reduce dock automatically only for the documented outage interval. Host outage alone does not stop the clock. |
| Claim release / reclaim cycling | On expiry, impose a 30-minute cooling period for the same party on the same work, then require a different Cell and a new admission snapshot. Three failed initial claims in 24h require jockey approval or a new scoped plan. Other parties can claim immediately if no overlap lock remains. |
| Transfer | Explicit handoff transfers one remaining claim generation only after the recipient accepts and capacity is reserved. It never restarts the four-hour commitment window. |
| Source changes during claim | Re-read source revision on renewal and before external side effects. Scope/cancel/blocker change freezes dispatch and sends work to Repair/reconcile; claimant must rebrief or release. |
| PR closed without merge | Record why. If superseded by another PR, reconcile association; otherwise repair or release. Do not count it as qualifying completion. |

### Dock and score policy

Do not make the score dock a hidden punishment. Display each release event on the item and party ledger: `claim expired; no qualifying commitment; −N reliability points`, with due time, evidence state and appeal/waiver link.

Recommended score mechanics:

- Award outcome points only after configured accepted/done evidence. Weight by task size/risk only if sizing is frozen before claim.
- First missed commitment in a rolling 30 days: **−1 reliability point**. Second: **−2**. Third and later: **−3**, capped at −6 per party per day. A proven intentional hoard or false artifact is a separate conduct event, not automatically inferred.
- Reduce to zero for a documented board/source outage; halve for externally verified upstream block occurring before the deadline and promptly checkpointed.
- Never dock for a reviewer queue, CI provider outage, a valid human hold, or slow work after qualifying commitment.
- Scorecards show completed outcomes, quality/reopen rate, median claim-to-commitment, aged/stale claims, review turnaround, spend efficiency and coverage. Do not rank raw token use or number of claims.

## 5. Migration from Tigeryard

### Import principles

Perform a one-time, read-only-source import per old board (Remilytics and decomp research). Preserve original issue key, board identity, all state/owner/controller/lane/priority/history, lease timestamps, evidence and attention events in an import envelope. Do not create active claims from stale Tigeryard leases. Put imported items in `imported_unreconciled` until tracker links and Git/PR observations have run once.

Create a native work item for every old issue. Add a source link `tigeryard:<board-id>:<issue-key>` and use the original item as primary only until the repo authority configuration says otherwise. Imported owner/controller become historical attribution, not a current party assignment; map to a party only through an explicit identity table. Old provider/model/session/branch/head fields become evidence references, never trusted current liveness.

### State and column mapping

| Old state | Old normal column | New initial lifecycle/disposition | New default group after reconciliation | Notes |
|---|---|---|---|---|
| `proposed` | Backlog | `unscoped` | Waiting / parked → Unscoped | No automatic dispatch. |
| `scoped` | Backlog | `scoped` | Waiting / parked → Awaiting admission | Retain scope and source revision. |
| `authorized` | Ready | `eligible` | Ready to pull if source/prerequisites fresh; otherwise Repair/reconcile | “Authorized” is not an active claim. |
| `ready` | Ready | `eligible` | Ready to pull if all new policy gates pass; otherwise Repair/reconcile | Recalculate readiness; do not trust old ready blindly. |
| `claimed` | Started | `claimed_unverified` | Repair/reconcile by default | Import lease history only. It becomes Running only if a fresh current claim is explicitly adopted. |
| `working` | Started | `claimed_unverified` | Repair/reconcile by default | Old lifecycle `working` is not live proof. Preserve receipts; may show historical `was working`. |
| `handoff_ready` | QA review | `submitted` | Ready to review only if current candidate, PR/proof and required checks are current; otherwise Repair/reconcile | Preserve handoff/evidence. |
| `review_ready` | QA review | `submitted` | Same as `handoff_ready` | The new review predicate decides. |
| `qa_ready` | QA review | `submitted` | Ready to review or Repair/reconcile | Map QA as a configured check/review requirement, not a permanent column. |
| `qa_running` | QA review | `verification_running` | Running if a current adopted verification attempt exists; otherwise Repair/reconcile | Do not infer an active process. |
| `repair_needed` | Agent repair if owned; Needs triage if unowned | `repair` | Repair/reconcile | Retain blocker and ownership history. |
| `blocked` | Agent repair if owned; Needs triage if unowned | `blocked` | Needs you only if a valid imported attention request is still current; otherwise Repair/reconcile or Waiting with explicit blocker | Plain blocker prose is not human attention. |
| `paused` | Agent repair if owned; Needs triage if unowned; Backlog when operator parked | `parked` if old operator block, otherwise `paused` | Waiting / parked, or Repair/reconcile | Preserve old operator-block audit separately. |
| `approved` | Closed | `accepted` | Done | Preserve candidate/gate basis. It is not publication unless separately evidenced. |
| `done` | Closed | `done` | Done | Recheck manifest/candidate evidence where available; flag `completion evidence unverified` rather than reopening silently. |
| `rejected` | Closed | `rejected` | Done | Preserve reason; never make ready automatically. |
| unknown/invalid | Needs triage | `import_error` | Repair/reconcile | Require reconciliation before display as ready. |

The old Human attention column is not a state. Import only current, nonexpired requirements that pass the new structured-request validator. Others become `attention import invalid` repair events with the original text preserved. Old operator-park events map to Waiting / parked and retain restoring-state metadata. Old Agent repair versus Needs triage grouping is recomputed from the imported state plus whether a mapped current party/owner exists.

### Import procedure

1. Freeze only the import snapshot, not the old board; record snapshot time and source schema/version.
2. Import work items, event history, evidence and all links with stable source IDs. Mark every live-looking field historical.
3. Configure per-repo authority and identity mappings. Attach external refs only from verified import data or explicit mapping.
4. Reconcile Git/PR/branch, tracker state and evidence. Create observed external records and overlap links before making any item claimable.
5. Recompute group predicates and readiness. Expired/missing old leases become visible Repair/reconcile records, not silently ready work.
6. Ask the jockey to resolve only exceptions: ambiguous identity, multiple tracker items, conflicting active branches, current human request, or terminal evidence gap.
7. Enable claims per repo only after the shared queue, party caps, telemetry coverage policy and release/dock job are active.

## Sources

### Local primary evidence

- Tigeryard projection and UI: `/private/tmp/claude-502/-Users-jamesbrennan-Developer-factory-board--claude-worktrees-optimistic-villani-e03249/f7298abf-083d-4e69-9511-1b0695533a51/scratchpad/tigeryard-main/board/{projection.py,attention.py,blockers.py,gates.py,priority.py,reviews.py,server.py,README.md}`.
- Tigeryard UI assessment: `/private/tmp/claude-502/-Users-jamesbrennan-Developer-factory-board--claude-worktrees-optimistic-villani-e03249/f7298abf-083d-4e69-9511-1b0695533a51/scratchpad/tigeryard-main/docs/{frontend-review.md,board-cutover.md}`.
- PR 20: https://github.com/bonklek/tigeryard/pull/20 (metadata and first 400 diff lines inspected through `gh`).
- Advisor notes: `/Users/jamesbrennan/Library/Application Support/Claude/side-session-notes/local_35eb5682-9b85-4f76-8d43-5b15fb77416e/advisors/{advisor-tigeryard-ux-2026-11-21.md,advisor-politburo-ux-2026-11-21.md}`.
- Politburo plans and UI invariants: `/Users/jamesbrennan/Developer/factory-board/.claude/worktrees/optimistic-villani-e03249/{AGENTS.md,design/swarm-frontend.md,design/work-lifecycle.md,design/human-attention.md,packages/board/src/inspect/app/{home,tasks,task,attention,presidium}.tsx}`.
- Prior research: `/Users/jamesbrennan/Library/Application Support/Claude/side-session-notes/local_35eb5682-9b85-4f76-8d43-5b15fb77416e/merger/research/{sota-task-trackers.md,sota-usage-tracking.md,tigeryard-inventory.md}`.

### Web sources

- Linear agents: https://linear.app/developers/agents
- Linear for agents: https://linear.app/changelog/2025-05-20-linear-for-agents
- GitHub Copilot coding agent: https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/
- GitHub Copilot cloud agent docs: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent
- Devin Linear integration: https://docs.devin.ai/integrations/linear
- Factory Linear delegation: https://docs.factory.com/delegations/linear
- Cursor Linear integration: https://cursor.com/docs/integrations/linear
- Codex Cloud: https://developers.openai.com/codex/cloud/
- Codex in Linear: https://learn.chatgpt.com/docs/third-party/linear
- OpenHands GitHub integration: https://docs.openhands.dev/openhands/usage/cloud/github-installation
- Gas Town launch: https://yegge.ai/essays/welcome-to-gas-town/
- Beads coordination: https://github.com/gastownhall/beads/blob/v1.3.4/docs/multi-agent/coordination.md
- Claude Code agent teams: https://code.claude.com/docs/en/agent-teams.md
- Kanban WIP limits: https://www.atlassian.com/agile/kanban/wip-limits
