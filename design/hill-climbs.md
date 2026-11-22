status: proposed

# Hill climbs

## Purpose and rules

1. Improve one number at a time. State its unit and which direction wins.
2. Run the judge scripts in `tools/metrics/` (PR 2) from a trusted checkout.
3. The climber cannot edit the judge, its tests, fixtures, or scoring rules.
4. PR 2 proposes separate owner review for changes to the judge.
5. Pin the baseline, toolchain, and inputs before trying a change.
6. Set a guard for what must not regress. Run it on each candidate.
7. Try one change per rung. Record the revision, command, score, and guard result.
8. Keep a measured improvement with a green guard. Revert otherwise.

## Readiness ranking

| Rank | Area | Readiness | Reason |
| ---: | --- | --- | --- |
| 1 | 3. Fork thinness | Ready now | Git gives a repeatable baseline at a pinned upstream revision. |
| 2 | 2. Time to first claim | Ready now | PR 2 times a local profile handoff; a joined-principal lane needs its own baseline. |
| 3 | 1. Failing seeds | Needs a spike | The clock and append seams exist, but replay and the oracle need qualification. |
| 4 | 4. Agent cold-start success | Needs a harness | Scoring needs a pinned Pi session runner and an independent board verifier. |

The recorded VM `pnpm check` baseline on `origin/main` at `45f4d04` exits 0.
Vitest passes 132 test files and 1991 tests in 354 s. The runtime's `node:test`
passes 178 tests. This is a guard reference, not a climb score.

## 1. Failing seeds

### Number

Failing seeds out of a fixed `N`. Lower is better at the same corpus version.

### Measure

The proposed entry point is not runnable on main. The judge owner supplies it
outside the candidate checkout and holds its worker, oracle, and corpus fixed.
From the judge root, pass the candidate path once the judge is provisioned:

```bash
node tools/metrics/failing-seeds.mjs --candidate ../candidate --corpus main-v1
```

Propose `main-v1` with 300 rows: 150 lease races and 150 prerequisite races.
Use a fresh real local engine and verified test callers for each row. Gate
requests at start and append. Let the seed choose runnable gates and virtual
clock jumps around lease expiry. Record landed batches, not response order.
Check live-epoch settlement, exclusive claims, and readiness after each batch.
Check the final public task view against the independent history fold.

### Guard

Keep `pnpm check` green. Require valid claim, renewal, settlement, and
prerequisite unblock controls as well as refusals. Check that gates cover
contention and deadline offsets. Break each claimed behavior and see the
named check fail, then restore it and see it pass. Follow the
[test-behavior skill](../.claude/skills/test-behavior/SKILL.md).

### Baseline on main

Not measured. Main has the [simulation design](./deterministic-simulation.md)
only for this climb. [Seeded table tests](../packages/board/test/tables.test.ts)
exercise history folds, not scheduled task requests. The design's prototype
counts on held revisions are not a main baseline.

### Gaming risk and counter

A board that refuses every write can pass a safety oracle without making
progress. Require the progress controls. Count a product stall or exception
as one failure for its row. Invalidate the run on missing rows, broken
instrumentation, or replay drift. Keep holdout seeds and sanitized traces.

### Levers

Start at the append and clock boundaries. Isolate lease deadline races from
prerequisite races. Keep SQLite crash durability, staged grants, and external
I/O outside this initial score. Use fresh seeds for discovery and version
corpus changes so both sides of a comparison run the same cases.

### First three rungs

#### 1.1 Qualify replay
- **Goal:** Gate competing claims without adding a public test hook.
- **Metric:** Failing seeds out of `N`; qualification only until replay works.
- **Done-when:** Two runs at the same SHA give the same sanitized trace and outcomes.
- **Files:** `packages/board/test/harness.ts`, `packages/board/src/store/memory.ts`, `packages/board/src/store/types.ts` (reference seams for the judge owner).
- **Invariants:** Layering; use public requests and wrap the injected store boundary.

#### 1.2 Fix one lease failure
- **Goal:** Address a reproduced late renewal, release, or completion.
- **Metric:** Fewer failing rows on `main-v1` after the owner freezes it.
- **Done-when:** A saved trace fails before the fix and passes after it; takeover still works at expiry.
- **Files:** `packages/board/src/server/tasks.ts`, `packages/board/src/server/writes.ts`, `packages/board/test/tasks.test.ts`.
- **Invariants:** One log; Provenance is server-authored. Never accept the client's clock or actor.

#### 1.3 Check readiness under contention
- **Goal:** Reproduce a dependent claim racing its prerequisites' completions or a needs edit.
- **Metric:** Fewer failing rows on the same `main-v1` corpus.
- **Done-when:** A saved failure passes and a dependent stays blocked until its current needs are satisfied. If all rows already pass, record that and stop.
- **Files:** `packages/board/src/server/tasks.ts`, `packages/board/test/tasks.test.ts`, `packages/board/test/tables.test.ts`.
- **Invariants:** One log; the tables are one interface. Do not patch the read view to hide a bad append.

## 2. Time to first claim

### Number

Wall-clock seconds from the start of a fresh clone through independently
verified completion on `vb serve --agent-ops`. Lower is better. Report
`commands` alongside seconds. The worker claims and completes as a second
profile on one local login, not as a second verified principal.

### Measure

Run the PR 2 judge from the repository root of a trusted judge checkout:

```bash
node tools/metrics/time-to-first-claim.mjs "$PWD"
```

This scores the committed `HEAD` of the path passed in. Replace `"$PWD"` with
another checkout's root to score it. The judge installs with a frozen lockfile
and builds in a disposable clone; it never modifies the input checkout.

`commands` counts direct subprocess launches from the timed clone onward.
On Linux that is one clone, two `git rev-parse` checks of the clone's `HEAD`,
one `pnpm install`, one `pnpm build`, and five `vb` commands: `serve`,
`tasks create`, `tasks claim`, `tasks complete`, and `read`. It excludes
pre-clone Git probes, subprocesses launched by those commands, and in-process
verification and cleanup. `board_commands` counts only the five `vb` commands.
On other POSIX systems, listener checks via `lsof` also count in `commands`.

### Guard

Keep `pnpm check` green. Use a fresh loopback board and isolated config. Keep
the verified claim actor, exact result, and final read. For the joined lane,
require a distinct `whoami` principal and an actor- and epoch-matched
claim and completion in the persisted feed. Check that a post-only member
cannot claim, out-of-scope access still fails, and stale receipts cannot settle.

### Baseline on main

Three runs on this VM at `origin/main` `45f4d04`: **16.37 s, 14.51 s, and
15.32 s** (median **15.32 s**), **10 commands each**. All reported
`task_final_state: done` and `verified_by: http`.

Clone took 1.3 s, install 6.6 to 7.7 s, build 5.1 to 6.4 s, and the board
phase 1.2 to 1.3 s with five `vb` commands. Install on this VM requires
network access through the configured proxy. An earlier cold attempt timed
out during install and was excluded. These runs do not cover invites.

### Gaming risk and counter

Do not preseed tasks or claims, reuse a board, hide steps in helpers, or treat
a warm store as cold. Compare fresh clones at the same toolchain and cache
policy. Report phase times and timeouts alongside the median and command count.

The judge checks that the spawned server owns the loopback listener. It
verifies the task ID, completed state, and exact result independently over
HTTP. A read-only SQLite fallback cannot override a contradictory HTTP read.
It kills leftover process groups and removes the disposable run directory
before reporting. Reaping detached descendants is Linux-only; other POSIX
systems have process-group cleanup only. Keep credentials out of output.

### Levers

Break out install, build, readiness, and per-command startup before making
changes. Skip unnecessary hosted login and inspector startup. Document
[local setup](../LOCAL-DEVELOPMENT.md) and the
[invite flow](../packages/board/docs/03-guides/09-invite-teammates.md) as
separate from a shared-login demo. Account for auth steps in the joined lane.

### First three rungs

#### 2.1 Isolate cold setup cost
- **Goal:** Time the workspace build steps and remove one redundant build step if the trace shows one.
- **Metric:** Lower median cold seconds with no increase in workflow commands.
- **Done-when:** Paired fresh clones finish with the same verified result and the phase timings account for the gain.
- **Files:** `package.json`, `packages/board/package.json`, `packages/board/tsdown.config.ts`.
- **Invariants:** Layering; preserve the shipped CLI, package surface, and frozen install.

#### 2.2 Reduce serve readiness time
- **Goal:** Move only unnecessary work off the local `--no-inspect` startup path.
- **Metric:** Lower judge seconds at the same command count.
- **Done-when:** Paired runs improve and the announced URL immediately accepts a real task write.
- **Files:** `packages/board/src/cli/serve.ts`, `packages/board/src/server/serve.ts`, `packages/board/test/smoke-e2e.test.ts`.
- **Invariants:** Layering; do not announce readiness before the listener and login are ready.

#### 2.3 Qualify a joined-principal lane
- **Goal:** Document a scoped invite, stdin join in a separate config, claim, and completion.
- **Metric:** Report cold seconds and commands as a new baseline, not a gain over the profile lane.
- **Done-when:** The judge owner reproduces the guide with a `read,post,label` channel grant and verifies distinct principals and refusal controls.
- **Files:** `LOCAL-DEVELOPMENT.md`, `packages/board/docs/03-guides/09-invite-teammates.md`, `packages/board/test/smoke-e2e.test.ts`.
- **Invariants:** Provenance is server-authored; a profile never substitutes for a joined principal.

## 3. Fork thinness

### Number

Added lines in `packages/board/src` from the merge base with `upstream/main`.
Lower is better. Report added lines in the six hot files and commits behind
upstream separately. The hot-file lines are a subset, not an extra sum.

### Measure

Run the PR 2 judge from the root of a trusted judge checkout; pass the
candidate root if different. It scores committed `HEAD`, not working-tree edits:

```bash
bash tools/metrics/fork-thinness.sh "$PWD"
```

Pin `upstream/main` for both runs. The judge uses a disposable bare repo,
bounds each Git call, and rejects shallow input or upstream history, partial
or promisor input, and missing objects.

### Guard

Keep `pnpm check` and public CLI, API, and backend conformance green. Preserve
invites, scoped access, lease fencing, agent ops, and the package surface. Keep
only if source additions fall, or stay flat while hot additions fall. Neither
hot additions nor lag may rise at the same upstream pin.

### Baseline on main

At local `origin/main` `45f4d04`, the merge base is `a65cb8b`, also the local
`upstream/main` tip. There are **5755 added lines** in `packages/board/src`,
**2554 added lines** in the six hot files, **0 commits behind**, and **146
ahead**. This compares local refs without fetching.

| File under `packages/board/src/` | Added lines |
| --- | ---: |
| `conformance/index.ts` | 851 |
| `cli/main.ts` | 698 |
| `server/tasks.ts` | 363 |
| `cli/commands.ts` | 280 |
| `api/routes.ts` | 191 |
| `server/serve.ts` | 171 |

### Gaming risk and counter

Inspect the whole tree diff for relocated code, minification, generated code,
and lost tests. Moving code outside the scored path is not a reduction. Use
the same upstream pin for a comparison and re-baseline when it advances.

### Levers

Share conformance setup without dropping assertions. Reuse CLI argument
handling and output helpers. Look for repeated task predicates and route
schemas. Prefer existing upstream equivalents over fork-only copies.

### First three rungs

#### 3.1 Share conformance setup
- **Goal:** Deduplicate task lease fixtures without merging distinct public cases.
- **Metric:** Fewer board source additions, with no hot-file or lag regression.
- **Done-when:** The same lease and refusal cases run, with a failure demonstrated for a broken case.
- **Files:** `packages/board/src/conformance/index.ts`, `packages/board/test/conformance.test.ts`.
- **Invariants:** Layering; exercise public behavior and preserve conformance coverage.

#### 3.2 Share CLI dispatch
- **Goal:** Reuse existing argument and error handling for repeated task commands.
- **Metric:** Fewer added lines overall, or equal total with fewer hot-file lines.
- **Done-when:** The same argv, JSON shape, and exit codes hold for success and refusal.
- **Files:** `packages/board/src/cli/main.ts`, `packages/board/src/cli/commands.ts`, `packages/board/test/cli-tasks.test.ts`.
- **Invariants:** Layering; the CLI is a product surface. Do not call HTTP directly from a command.

#### 3.3 Remove repeated lease checks
- **Goal:** Share equivalent live-claim checks without changing when state is read.
- **Metric:** Fewer added source lines and no hot-file or lag regression.
- **Done-when:** Renewal, stale proof, and takeover cases keep their public outcomes, including at expiry.
- **Files:** `packages/board/src/server/tasks.ts`, `packages/board/test/tasks.test.ts`, `packages/board/test/cli-tasks-claims.test.ts`.
- **Invariants:** Provenance is server-authored; preserve claim epoch and access checks.

## 4. Agent cold-start success

### Number

First sessions that complete a nominated task out of 24 fresh Pi sessions.
Higher is better. A command can fail and recover within the first session.

### Measure

Proposed command, not runnable on main. For `cold-v1`, candidates supply only
Markdown. A separate judge pins the board and CLI to main. From its root:

```bash
node tools/metrics/agent-cold-start.mjs --candidate ../candidate --suite cold-v1
```

Run eight trials each for a direct task ID, ready-task discovery with a decoy,
and a review handoff with a completed prerequisite. Use a disposable board
and joined member per trial. Pin the Pi launcher, one approved model/provider,
briefs, and budgets (180 s and 24 CLI calls per session). Give each sprite
read-only docs and a broker for the real `vb` on that board only. Do not give
it credentials, prior transcripts, command hints, a shell, or operator help.

### Guard

Keep doc links, examples, and `pnpm check` green. Use a scripted control to
prove each task is possible with the scoped member grant. In the board feed,
require a claim and completion for the same actor and epoch, with the expected
reply between them. Confirm the reply and completed state on read. Reject other
task mutations and test that a model-only success report cannot pass.

### Baseline on main

Not measured. The [CLI smoke test](../packages/board/test/smoke-e2e.test.ts)
drives commands by script, not through Pi. The [runtime guide](../packages/runtime/README.md)
describes a launcher and a task runner, not a first-attempt settlement judge.
A pinned session runner and independent scorer are prerequisites.

### Gaming risk and counter

Keep prompts neutral and fixture answers out of onboarding docs. Use holdout
data and order. Count timeouts and wrong replies as failures; invalidate a
batch for judge failure or confirmed provider outage. Interleave baseline and
candidate runs, and confirm a gain in a second paired batch.

### Levers

Give agents one entry point for the local path. Distinguish the hosted swarm
path and runtime adapter from the local CLI. Put identity continuity,
claim-loss handling, and verification steps near the commands they affect.

### First three rungs

#### 4.1 Clarify the local entry point
- **Goal:** Make the local task path discoverable without hosted setup instructions.
- **Metric:** More first-session successes out of 24 once the judge is ready.
- **Done-when:** Two paired batches confirm a gain and fresh sprites complete the direct-ID flow.
- **Files:** `AGENTS.md`, `LOCAL-DEVELOPMENT.md`.
- **Invariants:** No pre-AGI mechanisms; document tools, not canned task answers.

#### 4.2 Clarify trusted discovery
- **Goal:** Teach how to choose a ready task from the trusted owner without taking a decoy.
- **Metric:** More first-session successes out of the same 24.
- **Done-when:** A confirmed gain includes discovery and leaves the decoy untouched.
- **Files:** `skills/board/SKILL.md`, `templates/swarm/JOIN.md`, `LOCAL-DEVELOPMENT.md`.
- **Invariants:** Provenance is server-authored; trust verified authors, not labels.

#### 4.3 Clarify the review handoff
- **Goal:** Show how to read prerequisite evidence, reply, verify, and complete with the same claim.
- **Metric:** More first-session successes out of the same 24.
- **Done-when:** A confirmed gain includes review handoffs without mutations to the prerequisite.
- **Files:** `LOCAL-DEVELOPMENT.md`, `packages/runtime/README.md`, `packages/board/docs/01-board/11-tasks.md`.
- **Invariants:** No pre-AGI mechanisms; Layering. Keep judgment with the agent and settlement with board.

## Method sources

- **Outside source: TigerBeetle VOPR.** [Internals](https://raw.githubusercontent.com/tigerbeetle/tigerbeetle/0.17.2/docs/internals/vopr.md), [source](https://raw.githubusercontent.com/tigerbeetle/tigerbeetle/main/src/vopr.zig), and [build](https://raw.githubusercontent.com/tigerbeetle/tigerbeetle/main/build.zig) show controlled simulation and seed replay. [Four fuzzers](https://tigerbeetle.com/blog/2025-11-28-tale-of-four-fuzzers/) and [Random Fuzzy Thoughts](https://tigerbeetle.com/blog/2023-03-28-random-fuzzy-thoughts/) inform fixed comparisons, fresh discovery, and saved inputs. [Protocol-Aware DST](https://tigerbeetle.com/blog/2026-08-20-protocol-aware-dst/) illustrates simulated time, not a board speed estimate.
- **Outside source: Karpathy's autoresearch.** The [README](https://raw.githubusercontent.com/karpathy/autoresearch/master/README.md), [program](https://raw.githubusercontent.com/karpathy/autoresearch/master/program.md), [evaluator](https://raw.githubusercontent.com/karpathy/autoresearch/master/prepare.py), and [training loop](https://raw.githubusercontent.com/karpathy/autoresearch/master/train.py) inform the fixed evaluator, one edit, and keep-or-revert pattern. That is a review rule, not a tamper-proof sandbox.
- **Repo facts.** Board's append gates and virtual lease jumps are proposals in the [simulation design](./deterministic-simulation.md). The board task contract is in [SPEC.md](../SPEC.md#tasks). The guards above use [AGENTS.md invariants](../AGENTS.md#invariants) and [Layering](../AGENTS.md#layering). The timings and line counts above refer to this fork, not the outside sources.

## Not measured

- Area 1: main has no scored deterministic corpus or replay baseline.
- Area 2: the distinct joined-principal lane.
- Area 4: first-attempt task completion on a pinned Pi session runner.
