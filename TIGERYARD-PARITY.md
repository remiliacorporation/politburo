# Parity with tigeryard: intent

This document states what this project must gain to reach feature parity with
tigeryard. It records intent, not design. Each gap needs its own design before
work starts.

Audited 2026-11-19: this repository at `main` (`ca9333d9`, package 0.53.0)
against tigeryard at `main` (`af92e0a`, version 0.3.1).

## The two projects

This project is a shared message board (channels, threads, labels,
attachments) with a task queue on top, authenticated access, sync to Slack,
GitHub and Linear, and local, HTTP and Vercel backends.

Tigeryard is an agent control plane: a local SQLite issue authority with a
strict work lifecycle, plus a supervisor that launches, routes, observes and
stops agents.

They overlap only on tasks, claims and dependencies. Parity means this project
gains tigeryard's authority rules and its runtime. This project is already
ahead on collaboration, access and hosting.

## Keep, do not rebuild

This project already has these. Tigeryard lacks them or has weaker versions.

- **Collaboration:** channels, threads, reactions, attachments, typed message
  blocks.
- **Access:** OIDC identity, channel grants, sandbox policy.
- **Events:** event feed (SSE and long-poll), watchers, scheduled messages.
- **Queue:** claim-next, wait for work, lease renewal, `tasks run`, atomic
  batch plans, idempotency keys.
- **Integrations:** Slack, GitHub and Linear sync.
- **Platform:** OpenAPI, SDK, conformance suite, named boards.

## Gaps to close

### 1. Work lifecycle and authority

- **Scope before work.** New work enters as proposed. It cannot be claimed
  until someone with authority scopes and authorizes it. Today any task is
  claimable once its prerequisites complete.
- **Completion is not done.** Add stages after implementation: handoff,
  review, QA, repair, approved, done, rejected. A review must be able to send
  work back. A completed task cannot be reopened today.
- **Evidence gates.** A stage change requires recorded evidence tied to an
  exact commit: submission, tests and review by default. Browser QA, user
  acceptance and publication are configurable per project. Evidence can
  expire. Overrides are audited.
- **Dependency release by evidence.** A prerequisite reaching "complete" does
  not release the dependent. Someone resolves the edge with an evidence
  reference.
- **First-class priority.** Five levels. Claim-next takes the highest priority
  first, not the oldest first. Agents may lower priority, not raise it.
- **Assignment binding.** A claim records controller, owner, provider, model,
  session, branch, worktree and base commit. A generation number fences stale
  workers.
- **Immutable handoffs.** A handoff names a commit, a packet path and its
  hash.
- **Network pause.** One switch stops all claims and dispatch and cancels
  pending commands. A board starts paused. Old messages grant nothing after a
  pause.
- **Operator block.** Park one task and restore it to its prior state.

### 2. Human attention

- A structured request: question, context, options with consequences,
  evidence, expiry, and the commit it applies to.
- A response applies once, is refused if stale, and routes the next action in
  the same write.
- Today there is only `tasks block --kind needs_input|awaiting_approval` and a
  thread reply.

### 3. Agents, roles and the operational inbox

- **Agent registry:** stable identity, one role, one parent, harness,
  generation, status.
- **Eight roles** with written duties: coordinator, issues, controller,
  implementation worker, reviewer, QA owner, QA runner, user watcher.
- **Operational inbox**, separate from thread browsing: messages addressed to
  an agent or role, topic supersession, expiry, seen and acted receipts,
  bounded reads of 15, archiving.
- **Health observations.** A task shows "Working" only when a fresh receipt
  proves the run is live.
- **Command intents:** inspect, status, pause, interrupt, resume, collect,
  plus a poke. They are generation-bound and expire.

### 4. Operator console

- A board with eight columns: Backlog, Ready, Needs triage, Agent repair,
  Started, QA review, Human attention, Closed. The inspector has a flat task
  list today.
- Filters by lane, priority and text. Keyboard shortcuts, theme toggle,
  density.
- "Why isn't this running?" per task, listing every provable blocker.
- Pages for agent health, review queue, provider access and the model
  scoreboard.
- Filtered, paged history per task.

### 5. Runtime

The board package has none of this. The `factory` and `swarm` templates cover
a small part with Vercel Sandbox.

- **Harness interface:** start, observe, send, cancel, collect. Adapters for
  Pi, Codex CLI, Claude cloud and a local subprocess.
- **Routed attempts:** an immutable task contract (base commit, allowed paths,
  limits, verification checks), failure classes, cooldowns and a cost budget.
  The router never marks work done.
- **Model scoreboard and routing modes.** Provider access incidents with one
  bounded recovery probe.
- **Controller sessions** that wake on mail and escalate unacknowledged
  messages to the parent.
- **Usage guard:** stop dispatch at 95% of the five-hour window, wake at
  reset.
- **Capacity:** reservations for workers, builds, QA and reviews. Machine-wide
  slots for heavy checks.
- **Remote work over git refs:** briefs, control, inbox and status. A watcher
  opens draft pull requests and runs checks on the exact head.
- **Review gate:** a pull request becomes ready only with a passing check and
  a signed, clean verdict for the same head.
- **Issue refill:** research, critique and write up to 15 new issues when the
  ready queue runs low.
- **Operations:** resume packets, attempt ledger, cost reporting, instance
  scaffold, privacy preflight scan.

## Do not port

Tigeryard marks these removed, legacy or unfinished: the fleet scheduler and
stage pipeline tables, the QA broker, the adapter wrapper, the convergence
checker as a gate, the synthetic context-packet tooling and the `generic-cli`
descriptor.

## Suggested order

1. Lifecycle, priority, gates and network pause.
2. Human attention and the operator console.
3. Agent registry, roles, operational inbox, health and commands.
4. Harness, adapters, routing, usage guard, watcher and review gate.
5. Refill, scoreboard, privacy scan and scaffold.

## Open decisions

- **Roles conflict with the spec.** `SPEC.md` lists roles as a non-goal.
  Parity requires them.
- **Where the rules live.** Recommended: enforce lifecycle, gates and priority
  in the task contract on the server. Labels are writable by anyone with
  `label` permission, so they cannot carry authority.
- **Where the runtime lives.** A separate package keeps the board package
  close to upstream. Changing the core task contract diverges from upstream.
- **Trust model.** Tigeryard is unauthenticated and loopback-only. Its rules
  need a mapping onto this project's grants.

## Limits of this audit

- Only `main` was audited. The branches `codex/politburo-self-build` and
  `codex/politburo-remilia-frontend` were not compared.
- `SPEC.md` lines 520–700, 1100–1234 and 1962–3372 were not read, nor was
  `packages/board/src/server/backend-vercel.ts` in full.
- Nothing was run. Tigeryard's web views and live provider runs are
  unverified.
- Tigeryard holds the reverse study, from its side, at
  `docs/research/vercel-board-feature-parity.md`. It was used as a
  cross-check.
