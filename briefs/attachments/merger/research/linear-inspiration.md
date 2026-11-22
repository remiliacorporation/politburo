# Linear inspiration for Politburo

## Summary

Borrow Linear's **fast, dense, saved-list interface**, not its workflow wholesale. The important idea is to make each row answer: *what is this, who owns it, what happens next, and is it healthy?* Then put exceptional information—an expiring claim, blocked reason, overlap, or failing check—in a small, stable alert slot.

### Ranked recommendations

1. **Make “next actor” the primary grouping.** Keep the five decided groups: Needs me, Ready to review, Running, Available, Done. This is more useful than a status-column board for mixed people and swarms.
2. **Use a Linear-like compact list as the default.** One scannable row, sticky group headers, saved views, fast filters, and a detail peek. Keep columns optional.
3. **Separate party claim from accountable human.** Copy Linear's useful distinction between assignment and delegation, but adapt it: a ticket has one accountable owner and at most one active party claim.
4. **Make the four-hour contract machine-readable.** A claim is only allowed when the ticket has one or more explicit, verifiable acceptable outcomes. Otherwise it remains “Needs triage,” not claimable.
5. **Treat automation as evidence, not truth.** Show source, PR, checks, and timestamps. Auto-move only into a review-ready state; a person accepts completion.
6. **Adopt keyboard-first interaction and saved views.** This transfers well to agents and people. Do not copy Linear's SaaS seat, billing, or cloud assumptions.

## What Linear offers worth borrowing

### Information model

Linear centres work on an **issue**. An issue belongs to a team and moves through that team's ordered workflow. It can have an assignee, project, cycle, labels, priority, comments, and relations. Teams own their workflows and planning cadence. [Conceptual model](https://linear.app/docs/conceptual-model)

Workflow statuses are custom per team, but Linear also uses cross-team status *types*: backlog, unstarted, started, completed, and canceled. That split is valuable. Local status names preserve team language; category/type makes cross-team filters and reporting coherent. [Issue properties](https://linear.app/docs/issue-properties-home) · [Insights](https://linear.app/docs/insights)

**Adaptation:** retain a small internal lifecycle separate from the board grouping:

`triage → available → claimed/running → review → done | canceled | released`.

“Needs me / Ready to review / Running / Available / Done” is a computed *next-actor* field, not the only state machine. This avoids an eight-column kanban becoming a poor substitute for workflow data.

Linear's hierarchy is also useful, selectively:

- **Sub-issues** divide a deliverable. Relations express blocks, duplicates, and related work. [Parent and sub-issues](https://linear.app/docs/parent-and-sub-issues) · [Issue properties](https://linear.app/docs/issue-properties-home)
- **Cycles** are time-boxed issue sets and retain historical statistics. [Cycles](https://linear.app/docs/use-cycles)
- **Projects** group a bounded body of work; **initiatives** curate projects against a larger objective. [Projects](https://linear.app/docs/projects) · [Initiatives](https://linear.app/docs/initiatives)
- **Customer requests** connect external demand to work. [Customer requests](https://linear.app/docs/customer-requests)
- **SLAs** and estimates are issue properties; Insights can group across differently named team statuses by status type. [Issue properties](https://linear.app/docs/issue-properties-home) · [Insights](https://linear.app/docs/insights)

For Politburo, do not start by rebuilding initiatives or cycles. Keep ticket relations, source links, and optional parent/child work. Add a repo-level “batch/cycle” only when it answers a real planning question. The claim deadline is an operational SLA, not a cycle.

### Intake, attention, and reporting

Linear separates incoming work in **Triage** from scheduled/owned work. Triage is where new work is reviewed, assigned, prioritized, or routed. [Triage](https://linear.app/docs/triage) · [Conceptual model](https://linear.app/docs/conceptual-model)

Its Inbox and notifications create a personal attention layer. Pulse provides update feeds and permits personal, filter-based feeds. [Inbox](https://linear.app/docs/inbox) · [Notifications](https://linear.app/docs/notifications) · [Pulse](https://linear.app/docs/pulse)

**Borrow the separation, not the product surface:**

- **Triage / Needs me:** invalid outcomes, expired claims, failures, questions, manual-source changes, and conflicts.
- **Review queue:** PR/check evidence that needs a human decision.
- **Activity digest:** compact periodic summary of claims started, released, completed, spend, and incidents. It is not a second board.
- **Metrics:** lead time, expiry/release rate, acceptable-outcome pass rate, review wait, spend per accepted outcome, and overlap rate. Never reduce party quality to a single score alone.

### Views and display

Linear supports saved custom views, filters, list and board layouts, grouping, sub-grouping, ordering, and selectable visible properties. Its docs say issues can be grouped by status, assignee, project, priority, cycle, label, parent, team, customer, release, or SLA; sub-grouping works in lists and boards; headers stay sticky. [Custom views](https://linear.app/docs/custom-views) · [Display options](https://linear.app/docs/display-options) · [Board layout](https://linear.app/docs/board-layout) · [Filters](https://linear.app/docs/filters)

Use the same composable approach:

- default: dense **list**;
- optional: board for a spatial scan, never the only way to operate;
- group by next actor; optional subgroup by repo, party, source, priority, or claim-risk;
- ordering: urgency/risk first, then priority, then newest update; manual ordering only in Available;
- hide empty groups by default, with a one-click “show empty” option;
- compact / comfortable density; compact is default;
- property picker and saved, shareable views.

Linear's list also offers a peek preview. That is an excellent pattern: arrow through rows and inspect details without losing place. [Custom views](https://linear.app/docs/custom-views)

### Git integration and identifiers

Linear links branches, commits, and PRs to issues. Its GitHub documentation covers linking through branch names, PR titles/descriptions or commit “magic words”; configurable status automation; branch-specific rules; and optionally assigning/moving an issue when a branch is created. [GitHub integration](https://linear.app/docs/github-integration)

Adopt the evidence chain: `ticket ↔ branch ↔ commits ↔ PR ↔ checks`. Do not blindly mark work done when a PR merges. Merge should produce “Ready to verify” or “Done pending outcome verification” unless the specified outcome is exactly “merged PR”.

Linear issue IDs use a team key plus a sequential number (for example, `ENG-123`). The transferable property is a short stable, human-typeable namespace plus immutable sequence, rather than an opaque UUID. [Creating issues](https://linear.app/docs/creating-issues)

## Linear and agents (2025–2026)

Linear's published model is unusually relevant. Agents are installed app users with granted scopes. They can be mentioned and, subject to permissions, take many ordinary actions; admins control installation and team access. Linear says agents are not billable seats, while providers can have their own pricing. [Agent platform](https://linear.app/docs/agents-in-linear)

The key distinction is **assignment versus delegation**:

- Linear issues have one human assignee for clear ownership.
- A human can delegate the issue to an agent while staying assigned and responsible.
- Assignment/delegation history appears in activity; assigned/delegated work remains visible in My Issues; reporting can filter by assignee or delegated agent. [Assign and delegate issues](https://linear.app/docs/assigning-issues)

That is the right accountability model for Politburo. A party must never replace the accountable person. A party claim is a delegation/lease, not ownership transfer.

Linear Agent provides chat and in-context comments, multiple chat tabs with an indicator when a thread is working or has unread updates, reusable skills, scheduled/event-driven Loops, and coding sessions delegated from an issue. [Linear Agent](https://linear.app/docs/linear-agent) · [Agent platform](https://linear.app/docs/agents-in-linear)

Linear's 2025 agent announcements include a public interaction-guidelines/SDK release and integrations for external coding agents. [Agent Interaction Guidelines and SDK, 2025-07-30](https://linear.app/changelog/2025-07-30-agent-interaction-guidelines-and-sdk) · [Linear for Agents, 2025-05-20](https://linear.app/changelog/2025-05-20-linear-for-agents) · [Cursor Agent, 2025-08-21](https://linear.app/changelog/2025-08-21-cursor-agent)

**What this means for Politburo:** record a claim session as an append-only event stream: claimant party, initiating human/automation, start and hard expiry, agent run/session links, status heartbeats, artifacts, tokens/cost source and observed spend, and release/dock decision. Show the current run in the card; retain the full activity in the detail pane.

Linear documentation confirms visibility of agent activity and agent/assignee reporting. It does **not**, in the public pages reviewed, establish a universal per-session cost display for all third-party agents. Treat any claim that Linear exposes that exact universal UI as **unverified**. Linear does document AI credits for its own AI features. [Agent platform](https://linear.app/docs/agents-in-linear) · [AI credits](https://linear.app/docs/ai-credits)

### Design principles and dense UI

Linear's public product consistently favours fast interaction, keyboard shortcuts, opinionated workflows, and restrained visual density. Its docs demonstrate the concrete mechanisms: command/search surfaces, quick property edits, display-property selection, filtering, board/list views, sticky groups, and peek. [Search](https://linear.app/docs/search) · [Display options](https://linear.app/docs/display-options) · [Custom views](https://linear.app/docs/custom-views)

Do not overstate this as a verbatim Linear manifesto: the exact four-word formulation “speed, opinionated defaults, keyboard, restraint” is a useful synthesis, not a verified quote from one source.

Patterns to copy:

- a small status icon at the far left, then stable identifier and title;
- compact semantic glyphs, not coloured status pills everywhere;
- one avatar/owner marker; labels only when they alter a decision;
- right-aligned, low-emphasis metadata with consistent columns;
- hover/selection reveals secondary actions rather than permanently showing them;
- instant local/optimistic feedback, reconciled against server events;
- a detail peek instead of forcing a navigation change for inspection.

## What not to copy

- **Single-assignee semantics as the full model.** Politburo needs accountable person, claimant party, and perhaps originating human. Do not represent these as one overloaded assignee.
- **Per-seat SaaS concepts.** Parties are not billable user seats. Do not import seat invites, member billing, or provider-cost assumptions into core work state.
- **Cloud-only integrations and permissions.** GitHub, Slack, email, customer systems, and Linear Agent depend on external accounts and hosted services. Use adapters and source provenance; keep the board useful offline and self-hosted.
- **Status proliferation.** Linear permits custom workflows. Politburo should resist reproducing every agent micro-state as a board column. Put run detail in the drawer and retain five next-actor groups.
- **Automatic completion as authority.** A green check, PR merge, or agent assertion is evidence. It is not necessarily fulfillment of the ticket contract.
- **Personal-only attention as the sole control plane.** People who do not use Politburo still need work represented, accountable, and reviewable.

## Applied design

### Row anatomy (default compact list)

Use a 36–40 px row. Left to right:

1. **State icon** — next-actor/state category; tooltip and accessible text.
2. **Party stripe/dot** — a 3–4 px vertical colour stripe for active claimant; neutral outline for human/manual work. Never colour the whole row.
3. **ID + source** — `plb-482` followed by a tiny source mark, for example `GH#812`, `LIN ENG-123`, `beads:abc`. The native ID remains primary.
4. **Title** — one line, truncating late.
5. **Decision glyphs** — only when present: overlap `⧉`, blocked `!`, missing outcomes `?`, PR, check failure. Each has text in the accessible name and tooltip.
6. **Party / accountable owner** — compact party swatch/name plus avatar or initials for accountable human. Show both only when different.
7. **Right-aligned evidence** — PR/check state, then claim timer, then spend. Use fixed-width tabular numerals.
8. **Recency** — last meaningful update, muted.

Example:

`● │ plb-482 GH#812  Add retry cap  ⧉  [amber: Villani] [JB]  PR #91 ✓  01:12:34  $2.84  4m`

The timer is not a progress bar in every row. Show neutral time while safe; amber under 60 minutes; red under 15; an expired row moves to Needs me and says `EXPIRED`, not `00:00`.

Spend is a compact currency amount with budget/estimate only in the peek. Hide `$0` and unknown values. Overlap is an outlined warning glyph; show its reason and links to candidate tickets in the peek. This preserves scanning density.

### Card / peek anatomy

Opening a row uses a side peek; Enter opens the full ticket.

**Header:** state icon, `plb-482`, title, source badges, party colour/name, accountable owner, claim state and live deadline.

**Top evidence strip:** PR link and review state; CI/check summary; spend so far and budget; overlap warning; last heartbeat; source sync freshness. Put error text here, not only red colour.

**Body:** problem/context; acceptance/outcomes contract; activity timeline; links/relations and child work; files/branch/PR/commit evidence; comments and handoff notes.

**Claim panel:** claimed by, session/run links, started at, hard expiry, no-pause rule, release eligibility, cooldown until (after release), and dock outcome. It should state why a ticket is stuck in a human-readable sentence.

### Group headers

Sticky headers contain: state icon, name, count, brief rule, and aggregate risk.

- **Needs me** — a person must decide: triage, missing contract, expired/released claim, failed verification, conflict, or blocker. Header shows expired and blocked counts.
- **Ready to review** — deliverable evidence exists; reviewer/owner must accept, request changes, or release.
- **Running** — an active valid claim or human work. Header shows claims expiring in `<1h` and total live spend.
- **Available** — valid and claimable. Header shows count and highest priority; this is the only manually ranked queue.
- **Done** — accepted/canceled. Collapsed by default; hide after the selected retention window.

Use a filter rather than a sixth “Stuck” column. “Stuck” is a reason/property that appears as a warning and routes most cases to Needs me.

### Landing views

1. **My attention (default for a person):** Needs me + Ready to review, scoped to tickets they own, requested, or watch. Sort expiry, then severity.
2. **Repo operations:** all five groups for the repo. This is the shared default board.
3. **Available queue:** valid, unclaimed tickets, ranked by priority, age, dependency readiness, and overlap risk.
4. **Live claims:** Running only; group by party; show deadline and spend. This is the swarm supervisor view.
5. **Review queue:** PR/check evidence, owner/reviewer, and outcome verification.
6. **Exceptions:** expired, released, cooling down, missing outcomes, failed checks, stale heartbeat, and overlaps.
7. **History/scorecard:** completed and released claims with drill-down. It is a report, not a public shaming screen.

### Display controls

Offer: List/Board; compact/comfortable; group and subgroup; order; visible fields; hide/show empty groups; show closed; save/share view; filters for repo, source, party, owner, next actor, state, priority, claim risk, deadline, PR/check, spend range, outcome validity, overlap, and updated time.

Keep these defaults: list, compact, grouped by next actor, no subgroup, empty groups hidden, Done collapsed. Persist view choice per person but provide one shared “Repo operations” baseline.

### Keyboard map

Use familiar, discoverable shortcuts and show them in a `?` help overlay. Do not reserve bare keys while typing.

- `↑/↓` select row; `j/k` next/previous when focus is not text.
- `Enter` full ticket; `Space` peek; `Esc` close.
- `/` search/filter; `g` then `a/r/n/d` jump Available/Running/Needs-me/Done.
- `c` claim selected ticket (confirmation includes hard expiry); `x` release claim (requires reason); `r` request review; `d` mark done/accepted (requires outcome evidence selection).
- `p` attach/open PR; `o` open source; `l` add relation; `b` set blocker/reason.
- `f` filters; `v` display/view menu; `[`/`]` previous/next group.
- `Cmd/Ctrl+K` command menu for every action, including “claim next suitable ticket.”

Agents should call the same commands through an API. The API must enforce eligibility, expiry, cooldown, and outcome validation; keyboard/UI checks are convenience only.

### Four-hour acceptable-outcomes contract

Add a required structured section to the ticket description. Markdown remains readable; a front-matter-like block supplies machine semantics.

```markdown
## Acceptable outcomes
<!-- politburo-outcomes:v1 -->
- [ ] kind: pull_request
      repo: owner/repo
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
- reviewer: @james
- on_no_match: release_and_dock
```

Rules:

- Every outcome has a stable `kind`, criteria, and an evidence field/type that the adapter can verify.
- `completion_rule` is explicit: normally `any_outcome`; use `all_outcomes` only deliberately.
- A claim may be accepted only if one listed outcome validates before its hard expiry. A PR outcome must specify whether an open PR is enough or merge is required.
- The machine records verification result, evidence URI/path, timestamp, verifier version, and any human override.
- A person can override with a required reason. The override is visible in history.
- If outcomes are absent, malformed, or unverifiable, set `outcome_contract=missing/invalid`, route to **Needs me**, and disable claim. Do **not** silently make “work on it” an acceptable outcome. A human may repair the contract or explicitly mark the ticket manual-only.
- At 4h, atomically end the claim. If no verified outcome exists, release it, apply the configured dock, write the reason, and enforce a 15-minute same-party cooldown. No offline/downtime pause exists.

### Ticket identifiers and external trackers

Use the three-character repo tag in lowercase plus an immutable native sequence:

`plb-482`, `rml-127`, `kgm-54`, `rdn-203`, `rmw-18`.

Treat it as case-insensitive on input but display lowercase. Never reuse a number. A native ticket always has this ID even when imported from another tracker. Keep external identities as typed aliases, not substituted IDs:

- `plb-482` (canonical Politburo ticket)
- `github:owner/repo#812`
- `linear:ENG-123`
- `beads:bd-9f31`
- `native:plb-482` (only when needed in an API)

Store source system, source workspace/repository, opaque source ID, displayed key, URL, sync direction, and last-sync time. Render the short source badge in the row and all aliases in the peek. This prevents collisions such as multiple trackers having `#123`, while retaining the Linear-like benefit of a memorable, typeable primary ID.

## Sources and confidence

All product claims above use Linear's official documentation or changelog. The agent material is recent where dated (2025); docs are living pages and may change. The only explicitly unverified point is a universal third-party-agent per-session cost UI, because the reviewed public docs do not establish it.

- [Conceptual model](https://linear.app/docs/conceptual-model)
- [Issue properties](https://linear.app/docs/issue-properties-home)
- [Triage](https://linear.app/docs/triage)
- [Custom views](https://linear.app/docs/custom-views)
- [Display options](https://linear.app/docs/display-options)
- [Filters](https://linear.app/docs/filters)
- [Board layout](https://linear.app/docs/board-layout)
- [Assign and delegate issues](https://linear.app/docs/assigning-issues)
- [Agent platform](https://linear.app/docs/agents-in-linear)
- [Linear Agent](https://linear.app/docs/linear-agent)
- [GitHub integration](https://linear.app/docs/github-integration)
- [Cycles](https://linear.app/docs/use-cycles)
- [Projects](https://linear.app/docs/projects)
- [Initiatives](https://linear.app/docs/initiatives)
- [Customer requests](https://linear.app/docs/customer-requests)
- [Insights](https://linear.app/docs/insights)
- [Pulse](https://linear.app/docs/pulse)
- [Inbox](https://linear.app/docs/inbox)
- [Agent Interaction Guidelines and SDK (2025-07-30)](https://linear.app/changelog/2025-07-30-agent-interaction-guidelines-and-sdk)
- [Linear for Agents (2025-05-20)](https://linear.app/changelog/2025-05-20-linear-for-agents)
