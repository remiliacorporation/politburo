status: proposed
bonklek decides on this PR

# What each work package builds on

A later mob that starts a work package reads this first. It names the code on `main` that the package builds on or replaces, so two packages do not write the same thing twice. Paths are repo-relative. Lines are on `main` at `5f80e1b`. Open PRs are listed with their state when this was written, and each is input, not a dependency, unless a row says so.

The package list is the plan's section 7. Package names are `WP-<number>`.

**Contents**

1. [Rules for reuse](#rules-for-reuse)
2. [Existing code by area](#existing-code-by-area)
3. [Work packages](#work-packages)
4. [Open pull requests](#open-pull-requests)
5. [Runtime modules that change](#runtime-modules-that-change)
6. [Open](#open)

## Rules for reuse

1. A package that finds code here uses it. It does not write a second copy under `packages/swarm`.
2. `packages/runtime` stays a library of functions. A process that hosts them (a loop, a service) goes in `packages/swarm`, which imports the function from the runtime ([architecture](swarm-merger.md#packages-and-their-rules)).
3. Nothing here is changed in `packages/board/src` unless [board additions](swarm-board-additions.md) lists it, and it lists nothing as required.
4. A runtime module that sends mail through the operational inbox moves to thread mail when its package arrives ([swarm mail](swarm-mail.md)). [Runtime modules that change](#runtime-modules-that-change) lists them.

## Existing code by area

| Area | What exists | Where | State |
|---|---|---|---|
| Harness interface | `HarnessKind` (`pi`, `codex-cli`, `claude-cloud`, `subprocess`), `WorkSpec`, `Start`, `State`, `Failure`, a `Usage` of `costMicros` | `packages/runtime/src/harness.ts:1-27` | Shipped. `codex-cli` and `claude-cloud` are names without adapters. D11 drops the `codex-cli` adapter |
| Adapters | `fake`, `subprocess`, `pi` over a shared replay ledger | `packages/runtime/src/fake.ts`, `packages/runtime/src/process.ts`, `packages/runtime/src/pi.ts:26`, `packages/runtime/src/ledger.ts:24` | Shipped. `pi()` runs `pi-task <task-file>`; the launcher itself is not in this repo |
| Task runner | `runTask`: claim, renew, watch the pause epoch, run, release; never completes the task | `packages/runtime/src/runner.ts:39` | Shipped |
| Usage guard | `usageGuard` refuses at 95 percent until `resetAt`; `localUsage` reads a file or a trusted command | `packages/runtime/src/usage.ts:38-45,68-72` | Shipped. No wake at reset, no weekly window, threshold fixed |
| Capacity | Per-kind slots in process, host-wide heavy slots as lock directories | `packages/runtime/src/capacity.ts:29` | Shipped |
| Stall watcher and heartbeat | `stallWatcher`, `heartbeat`, `nextBeat`; sends through the operational inbox | `packages/runtime/src/stall.ts:11,47,150,217` | Shipped as functions. The caller must loop it |
| Controller loop | `runController`: follow events, read the operational inbox, record seen and acted, escalate a reference to the parent | `packages/runtime/src/controller/index.ts:41,69` | Shipped. Reads the operational inbox, which the transport no longer is |
| Name pool | `namePool` (spawners), `pickName`, `spawnerTitle` | `packages/runtime/src/names.ts:5,49,63` | Shipped. No reservation; secretary, species and item pools are not in code |
| Router | `createRouter`: quality, cost or latency routing, failure classes, in-memory cooldowns | `packages/runtime/src/router/route.ts:50` | Shipped as a library. The live router is a different program, the pi `fallback/codex-cursor` extension, which is not in this repo (WP-105 records it) |
| Scoreboard | `boardScoreboard`, `registerScoreboardSchema`: `runtime-attempt@1` blocks, the latest 100, deduped by attempt id | `packages/runtime/src/router/scoreboard.ts:27,49` | Shipped. The pattern for registering a block schema |
| Remote work over Git refs | `localGit`: compare-and-set text files on `remote/<agent>/{brief,control,inbox,status}` | `packages/runtime/src/remote/ref-store.ts:57` | Shipped. Never fetches or pushes |
| Remote watcher | `watchRemote().poll`: on a finished status, open or reuse a draft PR, read checks for the exact head | `packages/runtime/src/remote/watcher.ts:15` | Shipped as a function. Nothing calls it on a schedule |
| Code host | `CodeHost` interface and the `gh` adapter | `packages/runtime/src/remote/code-host.ts:7`, `packages/runtime/src/remote/gh.ts:51` | Shipped |
| Review gate | `reviewGate().markReadyIfAllowed`, `signVerdict`: ready only with passing checks and a signed clean verdict on the current head; never merges | `packages/runtime/src/remote/gate.ts:18,29` | Shipped. No severity level (gap G3 of [the frontend design](swarm-frontend.md#gaps-that-need-new-infrastructure)) |
| Ops | `refill` (up to 15 held tasks), resume packets and attempt files, privacy `scanDiff` and `preflight`, instance scaffold | `packages/runtime/src/ops/refill.ts:26`, `packages/runtime/src/ops/packets.ts:38`, `packages/runtime/src/ops/privacy.ts:89,118`, `packages/runtime/src/ops/scaffold.ts:47` | Shipped |
| Benchmark records | `bench-run@1` record, store and report | `packages/runtime/src/bench/record.ts:87`, `packages/runtime/src/bench/store.ts:5,16`, `packages/runtime/src/bench/report.ts:28` | Shipped ([benchmarks](benchmarks.md)) |
| Sprite log collector | Reads pi session logs under the launcher's sprites directory; one record per model; tokens, times, outcome | `tools/bench/sprite-usage.mjs:34`, `tools/bench/record.mjs:48` | Shipped. A parser of the same events WP-109 reads live |
| Fork thinness judge | New code in `packages/board/src` counts against the fork | `tools/metrics/fork-thinness.sh` | Shipped. WP-102 puts the line counts of `packages/swarm` beside it |
| Board primitives | Tasks and claims, attention, pause, parking, priority, labels with `if`, post idempotency, block schemas, grants, registry and intents | [board additions](swarm-board-additions.md#what-the-board-already-enforces) | Shipped |
| `vb serve --swarm` | Enables agent ops, makes the local owner an attention responder, advertises protocol 1; conflicts with `--team-tokens` | `packages/board/src/cli/swarm.ts:5-28` | Shipped. WP-112 proposes `swarm serve` on the Mac Studio instead, for a custom `authenticate` |
| Inspector | Views: home, presidium, tasks, attention, channel, settings | `packages/board/src/inspect/app/routes.ts:6-13` | Shipped |
| Skills and templates | Repo skills for PRs and tests; `skills/board`; `templates/swarm` (a fork-ready template that runs the npm release, not this checkout) | `.claude/skills/`, `skills/`, `templates/swarm` | Shipped. `templates/swarm` is not touched by this merger |

## Work packages

"Builds on" is code to reuse. "Replaces or absorbs" is code or design that the package makes obsolete. A package with no entry builds on no existing code.

### Phase 1

| WP | Builds on | Replaces or absorbs |
|---|---|---|
| 101 | The design docs: [architecture](swarm-architecture.md), [secretaries](swarm-secretaries.md), [frontend](swarm-frontend.md), [naming](swarm-naming.md) | `TIGERYARD-PARITY.md` as the plan of record |
| 102 | `packages/runtime/src/names.ts:5` for the default spawner pool; `tools/metrics/fork-thinness.sh` for the line count; the workspace setup in `pnpm-workspace.yaml:2` | Name pools as constants (they become data) |
| 103 | `packages/runtime/src/harness.ts:27` (`Usage`), `packages/runtime/src/bench/record.ts:87` for record validation style | Nothing. The ledger is new; `bench-run@1` stays a benchmark record, not spend |
| 104 | None. Parity cases are recorded from Tigeryard's code | Deleted in WP-803 |
| 105 | `packages/runtime/src/pi.ts:26` (the `pi-task` contract the adapter relies on) | Nothing |
| 106 | None (Tigeryard upkeep) | Nothing |
| 107 | `packages/runtime/src/remote/code-host.ts:7`, `packages/runtime/src/remote/gh.ts:51` for PR reads | Nothing. `watchRemote` reads one branch; the mirror reads all |
| 108 | `packages/runtime/src/controller/index.ts:41` (seen and acted, escalate to parent); `packages/runtime/src/stall.ts:47,150` | Shadow only in this package: it replaces no live secretary until WP-202 to 204, and the Haiku sessions retire in WP-207. `secretaryd` (Tigeryard PR 56) is not merged |
| 109 | `tools/bench/sprite-usage.mjs:34` (the event parsing), `packages/runtime/src/pi.ts:26` (the adapter that starts sprites) | Nothing. The collector reads logs after the run; the supervisor reads them live |
| 110 | None on main. Claude Code telemetry has no reader here | Nothing |
| 111 | WP-110's receiver | Nothing |
| 112 | `packages/runtime/src/ops/scaffold.ts:47` (an instance directory without credentials); `vb serve --dir` and the directory lock (`packages/board/src/store/directory-lock.ts`) | Nothing |
| 113 | `board({ authenticate })` (`packages/board/src/server/auth.ts:610-627`); the Tailscale verifier as a model (`packages/board/src/cli/tailscale.ts:25-38`) | Nothing in the board |
| 114 | None on main | Nothing |

### Phase 2

| WP | Builds on | Replaces or absorbs |
|---|---|---|
| 201 | `registerScoreboardSchema` as the pattern for registering `swarm-message@1` (`packages/runtime/src/router/scoreboard.ts:27`); label `if` and post `id` | The operational inbox as transport |
| 202 | WP-108 and WP-201 | `secretary_wake` on that tag, kept as the rollback |
| 203 | WP-202 | The same, tag by tag |
| 204 | `vb post --schema` (`packages/board/src/cli/commands.ts:401-405`) | `core_mail.sh` |
| 205 | WP-108 | Nothing. Jev is new |
| 206 | WP-205; the pi adapter (`packages/runtime/src/pi.ts:26`) for the Terra call | Tigeryard PRs 51 and 53 are input only |
| 207 | WP-202 to 204 | Haiku secretaries; the stuck-secretary check of `core-watch.sh` |
| 208 | `skills/board`, `.claude/skills/` for layout | The Tigeryard skills. Installed copies must not link to the Tigeryard repo |
| 209 | `pickName` and the name pools (`packages/runtime/src/names.ts:49`); label `if` for the serial | The shell one-liner on the serial file; the pool as a constant |

### Phase 3

| WP | Builds on | Replaces or absorbs |
|---|---|---|
| 301 | None in the repo (browser work by core) | Nothing |
| 302 | `packages/runtime/src/pi.ts:26` | The pasted setup script v10 |
| 303 | WP-301, 302 | Nothing |
| 304 | WP-109; Tigeryard PR 50 (mob scripts, not merged) | Nothing |
| 305 | WP-303 | Nothing |

### Phase 4

| WP | Builds on | Replaces or absorbs |
|---|---|---|
| 401 | Tasks, `block` for a contract hold (`packages/board/src/server/tasks.ts:881-895`), attention (`packages/board/src/contract/attention.ts`), `tasks.createMany` (`packages/board/src/client/client.ts:751-808`) | Nothing |
| 402 | The board's claim, lease and fence (`packages/board/src/server/tasks.ts:343-372,845-856`); `runTask` (`packages/runtime/src/runner.ts:39`) for the renew loop | Nothing in the board. See [board additions](swarm-board-additions.md#the-additions) A1 to A4 |
| 403 | Grants (`packages/board/src/server/grants.ts:153`), invites | Nothing |
| 404 | The inspector (`packages/board/src/inspect/app/`), including the Needs action page (PR 75), the work list (PR 76) and the time rule (PR 77) if they land; the `store.ts` and `board.ts` rules of AGENTS.md | PR 44 (queue and mobs views, held). The "Presidium" page (`app/presidium.tsx`) is replaced |
| 405 | The settings view (`app/settings.tsx`) as the shell for a config editor | Nothing |
| 406 | The composer and feed (`app/composer.tsx`, `app/feed.tsx`) | Nothing |
| 407 | The sync package for GitHub and Linear webhooks (`packages/board/src/sync`) as reference; the adapters themselves are new | Nothing |
| 408 | `bench` and ops packet patterns for evidence files (`packages/runtime/src/ops/packets.ts:38`) | Nothing |
| 409 | `watchRemote` (`packages/runtime/src/remote/watcher.ts:15`) as the model for status reads; the decisions tool (PR 45, open) for importing open asks | PRs 59 and 60 of Tigeryard (board reporting, not merged) |

### Phase 5

| WP | Builds on | Replaces or absorbs |
|---|---|---|
| 501 | `stallWatcher` (`packages/runtime/src/stall.ts:150`) | `core-watch.sh`; the keep-awake no longer needed on the Studio |
| 502 | `capacity` heavy slots (`packages/runtime/src/capacity.ts:29`); `scanDiff`, `preflight` (`packages/runtime/src/ops/privacy.ts:89,118`); `ghCodeHost` for status | The Tigeryard check lock tooling copies |
| 503 | WP-201 | Nothing |
| 504 | `usageGuard` (`packages/runtime/src/usage.ts:68-72`), `capacity` | The 95 percent constant; the missing wake at reset |

### Phase 6

| WP | Builds on | Replaces or absorbs |
|---|---|---|
| 601 | `design/work-lifecycle.md`; Politburo PRs 20 and 21 as input | PRs 20 and 21 (held) are redesigned, not rebased; see [open pull requests](#open-pull-requests) |
| 602 | `watchRemote`, `reviewGate`, `ghCodeHost`, `localGit` (`packages/runtime/src/remote/`) | Nothing. The loop that hosts them is new |
| 603 | `refill` (`packages/runtime/src/ops/refill.ts:26`), resume packets (`packages/runtime/src/ops/packets.ts:38`), `boardScoreboard`, bench records | Nothing |
| 604 | None. Tigeryard's parity cases and a seeded board with screenshots of every screen are the reference for 601 to 603 | Nothing |

### Phases 7 and 8

| WP | Builds on | Replaces or absorbs |
|---|---|---|
| 701 | The ledger (WP-103), outcome records (WP-401, 408), bench report (`packages/runtime/src/bench/report.ts:28`) for the report shape | Nothing |
| 801 | None. A temporary tool outside the repo | Deleted after use |
| 802 | None | Tigeryard's open PRs, mobs and repo, closed with a pointer to the package that replaced each |
| 803 | None | `packages/swarm/parity/`, the file bridge and any test that names no failure |
| 804 | None | The Tigeryard spawner and its secretary; `ty-brief/*` branch names |
| 805 | None | The `bonklek/tigeryard` repository, archived by bonklek |

## Open pull requests

State as of this writing. Each is input to a package, not a dependency.

| PR | What it does | State | Package that uses it |
|---|---|---|---|
| [#20](https://github.com/remiliacorporation/politburo/pull/20) | Evidence gates on task completion | Open, held on security findings | WP-601 redesigns it |
| [#21](https://github.com/remiliacorporation/politburo/pull/21) | Opt-in lifecycle stages | Open, held | WP-601 redesigns it |
| [#39](https://github.com/remiliacorporation/politburo/pull/39) | Follow-ups on names, smoke test and stall | Open, one blocking finding | WP-102 (names), WP-501 (stall) wait for it or take its hardening |
| [#44](https://github.com/remiliacorporation/politburo/pull/44) | Swarm queue and mobs views | Draft, re-review failed | WP-404 reuses what fits, then it closes |
| [#45](https://github.com/remiliacorporation/politburo/pull/45) | A decisions tool on threads and labels | Open | WP-409 (one inbox for decisions) |
| [#75](https://github.com/remiliacorporation/politburo/pull/75) | A "Needs action" landing page | Draft, blocking findings | WP-404 (Needs you) |
| [#76](https://github.com/remiliacorporation/politburo/pull/76) | Priority and claim order in the task list | Draft, blocking findings | WP-404 (the queue) |
| [#77](https://github.com/remiliacorporation/politburo/pull/77) | One time rule across the inspector | Draft, blocking finding | WP-404 (row times) |
| [#79](https://github.com/remiliacorporation/politburo/pull/79) | One write queue per local store (single writer) | Open, no sprite review round | WP-402 (claims and renewals race on one store) |
| [#70](https://github.com/remiliacorporation/politburo/pull/70), [#80](https://github.com/remiliacorporation/politburo/pull/80) | Benchmark suite and runner | #70 is replaced by #80, a draft | WP-109 reads the same sprite logs; no overlap in code |

## Runtime modules that change

| Module | Change | Package |
|---|---|---|
| `packages/runtime/src/stall.ts:217` | Sends one operational-inbox message per topic. It sends a thread mail of class `policy` or `core.escalate` instead | WP-501 |
| `packages/runtime/src/controller/index.ts:69` | Reads the operational inbox. It reads inbox threads and labels, or is replaced by the secretary service's own loop | WP-108, WP-201 |
| `packages/runtime/src/usage.ts:72` | Fixed 95 percent. Threshold from config; a wake at reset | WP-504 |
| `packages/runtime/src/names.ts:5` | The spawner pool as a constant. Default data in `packages/swarm`, read through the config | WP-102, WP-209 |
| `packages/runtime/src/remote/gate.ts:5` | No severity. Add an optional `level` (frontend design G3) | WP-602 |

## Open

Found here.

1. **`packages/runtime/src/controller/index.ts` has two readers once mail moves.** The secretary service replaces the controller loop for spawners (WP-108). Whether `runController` stays as a library for other tiers (core, a human's watch) is not decided; WP-201 decides when it moves the inbox read.
2. **The sprite helpers and the pi router are not in this repo.** WP-105 records their text from Tigeryard and WP-302 moves them. Nothing here cites them, because there is nothing on `main` to cite.
3. **PR 79 changes how `local()` orders writes.** It decides each write at one serialization point, so a write whose lease, grant or pause changed between request and save is refused. WP-402's checks (a race for one claim, a renewal at the hard end) run on `main`'s behaviour unless the PR lands first. Both outcomes are acceptable; the package notes which it ran on.
