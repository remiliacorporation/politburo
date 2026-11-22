# Politburo inventory for the Tigeryard merger

Read-only research. Source: checkout `/Users/jamesbrennan/Developer/factory-board/.claude/worktrees/optimistic-villani-e03249` at `origin/main` `b146e75b` (`@vercel/board` 0.54.0, `@remilia/politburo-runtime` 0.0.0 private). Date: 2026-11-21.

Nothing was built or run. Maturity ratings come from reading code, docs, test file names and PR bodies. Test counts are quoted from PR bodies (#44: 1,918 board tests and 168 runtime tests; #39: 1,909 and 178), not measured here.

## 0. Fork size

- `git log --oneline upstream/main..origin/main`: 187 commits.
- `git diff --stat upstream/main...origin/main`: 307 files changed, 29,328 insertions, 1,996 deletions.
- Files the fork added, by area: `packages/board` 66 (source, tests, docs, the `test/dst/` harness), `packages/runtime` 50 (all of it), `design/` 12, `docs/politburo-theme` 8, `tools/metrics` 4, `.github/assets` 2, `.changeset/*` about 40, plus `TIGERYARD-PARITY.md`, `LOCAL-DEVELOPMENT.md`, and `.claude/skills` additions.
- Top-level paths today: `packages/{board,runtime}`, `templates/{factory,swarm}`, `skills/{board,configure-factory-board}`, `tools/metrics`, `design/`, `apps/preview-publisher`, `docs/politburo-theme`, `SPEC.md` (5,025 lines), `AGENTS.md`, `README.md`.
- The fork is not thin inside `packages/board/src`: lifecycle, attention, registry, inbox, intents, pause, park, priority, invites, team tokens, swarm flag and inspector views all live there. `tools/metrics/fork-thinness.sh` exists to measure this.

## 1. Layers

| Layer | Path | What it does | Public surface | Maturity | Test command |
| --- | --- | --- | --- | --- | --- |
| Board protocol and policy | `packages/board/src/{api,server,contract}` | Routes, validation, auth, grants, middleware, then the backend. Request schemas in `src/api/routes.ts` are shared by server and handle. | `board()` handle (`@vercel/board`), 100+ HTTP routes (list in 1a), `@vercel/board/{access,schemas,conformance,sync*,inspect,backend-local,cli}` | Shipped and tested | `pnpm --filter @vercel/board test` (vitest, 148 files in `packages/board/test`) |
| Store | `packages/board/src/store` (`sql.ts`, `sqlite.ts`, `memory.ts`, `types.ts`) | `MessageTables` on SQLite or memory, folded from the A2 log (`server/a2.ts`). One log, session `board`. | Internal. `local({ dir, memory, agentOps, attentionResponders, agentHealthFreshnessSeconds })` | Shipped and tested | `packages/board/test/tables.test.ts`, `store.test.ts` |
| Backends | `src/backend-local`, `src/backend-http`, `src/backend-vercel` | `local()` in process, `http()` to `BOARD_URL`, `vercel()` to Vercel's API | `local()` exported. `http()` and `vercel()` internal. | Shipped. Fork features are 501 on `vercel()` (`no_task_authority`, `no_task_attention`, `no_agent_ops`, `no_operational_inbox`, `no_network_pause`). | `backends.test.ts`, `conformance.test.ts`, `http-*.test.ts` |
| Scheduler | `src/scheduler/local.ts`, `src/server/schedules.ts` | In-process timers for scheduled messages and watcher or sync retries on `local()` | `team.schedule`, `vb schedule`, `vb schedules`, `POST /schedules` | Shipped. Timers are lost on restart. Sends skipped during a pause do not catch up. | `schedules.test.ts`, `local-scheduler.test.ts`, `cli-schedules.test.ts` |
| Sync | `src/sync/*` | Two-way Slack, GitHub, Linear through Chat SDK adapters and Vercel Connect | `@vercel/board/sync-{slack,github,linear,chat-sdk}`, `vb sync`, `vb sources`, `vb inbox <key>` | Shipped (upstream). `vb serve` mounts no sync. | `sync.test.ts`, `slack-*.test.ts`, `github-webhook.test.ts`, `linear-webhook.test.ts` |
| CLI `vb` | `packages/board/src/cli` (`commands.ts` data, `main.ts` 3,590 lines, `serve.ts`, `swarm.ts`, `local.ts`) | The handle as commands. No HTTP of its own. | Commands in 1b | Shipped and tested as a subprocess | `cli*.test.ts`, `smoke-e2e.test.ts`, `swarm-serve.test.ts`, `responder-serve.test.ts`, `serve*.test.ts` |
| Inspector `vb inspect` | `packages/board/src/inspect` (`server.ts`, `handler.ts`, `app/*`) | Local web UI on the handle through a token-carrying proxy. Also served by `vb serve` on the board's port. | Views in 1c | Shipped. Swarm views partial (queue and mobs only in draft PR #44). | `inspect*.test.ts`, `attention-keys.test.ts`, `docs-guide.test.ts` |
| Runtime package | `packages/runtime` | Runs one board task in a harness, plus dispatch policies and ops helpers. Uses only the public handle. A library: wired into no CLI and no daemon. | Modules in 1d | Shipped and tested as a library. No long-running process exists. | `pnpm --filter @remilia/politburo-runtime test` (`node --test test/*.test.ts test/ops/*.test.ts` after `tsc` build) |
| `templates/swarm` | `templates/swarm` | Upstream Next.js app: launcher page, agents in Vercel Sandboxes, queue on board tasks, read-only live page. Runs the npm release, not this checkout. | `JOIN.md`, `scripts/worker.ts`, `scripts/seed.ts`, `sandbox/runner.ts`, `app/live`, `app/api/live` (SSE), `lib/swarm.ts` (snapshot) | Shipped upstream. Needs Vercel team, Sandbox, AI Gateway credits, Connect. Not usable with no paid service. | `pnpm test` in the template (`test/swarm.test.ts` on `local({ memory: true })`) |
| `templates/factory` | `templates/factory` | Upstream Next.js app: one agent on a team board that takes issues to PRs with GitHub and Slack sync | `agent/`, `lib/launcher.ts`, `lib/setup.ts` | Shipped upstream. Vercel-hosted. | Its own `test/` |
| Skills | `skills/board/SKILL.md`, `skills/configure-factory-board/SKILL.md`, `.claude/skills/{pr-description,test-behavior,verify-board}` | `board`: teaches an agent `vercel board`. `configure-factory-board`: hosted factory setup. Repo skills: PR text, test discipline, sandbox verification. | `npx skills add vercel/board --skill board -g` | Shipped. No swarm, spawner, secretary or mob skill exists in the repo. | none |
| Metrics judges | `tools/metrics` (`fork-thinness.sh`, `time-to-first-claim.mjs`) | Judges for two hill climbs. Climbers may not edit them. | The two scripts | Shipped (#55). Not part of `pnpm check`. | `node --test tools/metrics/test/` |
| DST harness | `packages/board/test/dst` | Seeded simulation of lease, access and claim-file races over in-process HTTP and a memory store | `DST_SEEDS`, `DST_SEED`, `DST_EXPECT` env | Partial (#54 spike). E1 to E4 are pending on main because the guards they check are in held PRs #20 and #21. | `DST_SEEDS=300 pnpm --filter @vercel/board exec vitest run test/dst` |
| Design docs | `design/*.md` (12) | Intent. See section 3. | none | Design-only, each with a status table saying what shipped | none |
| CI and release | `.github/workflows/{check,release}.yml` | `pnpm check` on PRs, main and `board/**`. Release by changesets. Publishing disabled on the fork (#47). | `check` status | Shipped | `pnpm check` |
| Preview publisher | `apps/preview-publisher` | Upstream static Vercel project that serves a PR's tarball | none | Upstream, Vercel-hosted | none |

### 1a. HTTP routes (`packages/board/src/api/routes.ts`, lines 1358 to 1506)

- Board: `GET /`, `GET /me`, `GET /openapi.json`.
- Control (fork): `GET /control`, `POST /control/pause`, `POST /control/resume`.
- Channels and actors: `GET|POST /channels`, `GET /actors`, `GET /avatars/:name`.
- Messages: `GET /messages`, `GET /messages/:id`, `GET /threads`, `POST /messages`, `POST /messages/:id/{edit,delete,reactions,labels,sync,typing}`, `GET /messages/:id/sync`, `GET /links`, `GET /posts/:id`.
- Events: `GET /events` (`after`, `wait` 0 to 300 s, `all`, `last` up to 100, plus label filters). SSE via `src/client/sse.ts`.
- Schedules: `POST /schedules`, `GET /schedules`, `POST /schedules/:id/cancel`.
- Tasks: `GET /tasks`, `POST /tasks`, `POST /tasks/batch`, `GET /tasks/batch/:id`, `POST /tasks/claim`, `POST /tasks/:id/{claim,renew,release,complete,fail,block,unblock,park,unpark,handoff,reopen,assign,needs,priority,cancel}`, `POST|GET /tasks/:id/attention`, `POST /tasks/:id/attention/:requestId/answer`.
- Agent ops (fork, opt-in): `GET|POST /ops/agents`, `POST /ops/agents/:agent/{heartbeat,retire,intents}`, `GET /ops/agents/:agent/intents`, `POST /ops/intents`, `POST /ops/intents/:id/{take,report}`, `GET /ops/health/:task`.
- Operational inbox (fork): `POST|GET /operational-inbox`, `POST /operational-inbox/:id/{ack,archive}`.
- Access: `GET|POST /grants`, `POST /grants/batch`, `PATCH /grants/:id`, `GET /grants/explain`, `POST /grants/:id/revoke`, `GET|POST /invites`, `POST /invites/:id/revoke`, `POST /invites/redeem`.
- Schemas: `GET /schemas`, `GET /schemas/:id`, `POST /schemas`.
- Files: `POST /attachments`, `GET /attachments/:id`, `POST /attachments/uploads`, `POST /attachments/uploads/:id`.
- Watchers: `GET|POST /watchers`, `GET /watchers/matches`, `POST /watchers/matches/:id/ack`, `POST /wake`.
- Sync plumbing: `GET|POST /inbox/:key`, `GET /inbox/:key/next`, `POST /inbox/:key/:id/ack`, `POST /sync/{imports,receipts}`, `GET /sync/{threads/:thread,find,copies}`, `GET /sources/:key/read`, `POST /sources/:key/join`, `POST /webhooks/:key`.

### 1b. CLI commands (`packages/board/src/cli/commands.ts`, `local.ts`)

`whoami`, `join <url> <invite>`, `invite {create,list,revoke}`, `status`, `pause`, `resume`, `grants {list,create,update,explain,revoke}`, `channels {list,create}`, `schemas {list,inspect,create}`, `actors`, `read`, `post`, `reply`, `schedule` (+ `cancel`), `schedules`, `edit`, `delete`, `react`, `label` (`--if`, `--if-unset`), `typing`, `sync`, `inbox {read,ack,archive,raw}` and `inbox <key>`, `sources {read,join}`, `download`, `conformance`, `tasks {create,show,priority,claim,run,renew,release,complete,fail,block,ask,attention,answer,unblock,park,unpark,handoff,reopen,assign,needs,cancel}`, `agents {list,register,heartbeat,retire,issue-intent,issue-role-intent,intents,take-intent,report-intent,health}`, `hooks` (+ `uninstall` for claude, codex, cursor, pi), `hook`, `tail`, `wait`, `help`. App commands: `serve`, `inspect`.

`serve` flags: `--port` (4100), `--dir`, `--host`, `--team-tokens`, `--no-inspect`, `--no-open`, `--agent-ops`, `--swarm`, `--responder`, `--allow-host`, `--tailscale`. Global: `--json`, `--as`, `--scope`, `--url`. Env: `BOARD_URL`, `BOARD_NAME`, `BOARD_TOKEN`, `BOARD_PROFILE`, `BOARD_AVATAR`.

### 1c. Inspector views (`packages/board/src/inspect/app/routes.ts`)

| Route | File | What a user can do | Where |
| --- | --- | --- | --- |
| `/` HANDOFFS | `app/home.tsx` | Tasks in lanes with delivery result, hold reason, needs; open a thread | main |
| `/presidium` PRESIDIUM | `app/presidium.tsx` | Board name and address, task counts by state. Says more boards appear when reachable. One board only. | main |
| `/tasks` | `app/tasks.tsx`, `app/task.tsx` | Flat task list with filters. Per task: block, unblock, reopen, assign, cancel, park, unpark, change priority, create a task from a thread, answer attention | main |
| `/attention` | `app/attention.tsx`, `attention-store.ts`, `attention-keys.ts` | Open structured attention requests, oldest first. `j`/`k` select, `1` to `8` answer. Disabled when the viewer is not a responder. | main (#53) |
| `/c/<channel>` | `app/feed.tsx`, `message.tsx`, `composer.tsx` | Read, post, reply, react, edit, delete, label, attach, filter by label; thread pane state in the URL | main |
| `/settings/access` | `app/grants.tsx` | List, create, revoke grants; explain a channel | main |
| `/settings/schemas` | `app/schemas.tsx` | List and register schemas | main |
| `/settings/schedules` | `app/settings.tsx` | List and cancel schedules | main |
| `/settings/watchers` | `app/settings.tsx` | List watcher registrations (managers only) | main |
| `/settings/sync` | `app/settings.tsx` | Sync entries and their raw inbox | main |
| Pause banner and control, "acting as" identity | `app/App.tsx` (`PauseControl`, `PauseBanner`) | See a pause, pause or resume with a reason, see which identity writes | main (#57) |
| `/swarm/queue`, `/swarm/mobs` | `app/swarm.ts`, `app/swarm-views.tsx` | Ready work in claim-next order, decisions answerable, claims grouped by session and branch with lease and latest handoff | Only in draft PR #44 |
| `/swarm` tree, `/swarm/inbox/<tag>`, `/swarm/prs`, `/swarm/escalations` | none | Registry tree, mail headers and digests, PR gate, escalation chain | Design only (`design/swarm-frontend.md` phases 2 to 5) |

The inspector never reads the agent registry, the operational inbox, or intents today (`app/board.ts` has no `team.agents` or `team.operationalInbox` call).

### 1d. Runtime modules (`packages/runtime/src`, 2,472 lines)

| Module | Exports | What it does | Maturity | Test file |
| --- | --- | --- | --- | --- |
| `harness.ts` | `HarnessKind` (`pi`, `codex-cli`, `claude-cloud`, `subprocess`), `WorkSpec`, `Start`, `State`, `Observation`, `Result`, `Failure`, `Harness` (start, observe, send, cancel, collect) | The adapter interface | Shipped | `test/adapters.test.ts` |
| `conformance.ts` | `@remilia/politburo-runtime/conformance` | Shared `node:test` suite for adapters | Shipped | `test/adapters.test.ts` |
| `fake.ts` | `fake()` | In-memory adapter | Shipped | `test/adapters.test.ts` |
| `subprocess.ts`, `process.ts`, `ledger.ts` | `subprocess({ command, args })`, `Spawn` | Fixed command in a temp dir, scrubbed env, process-group kill, replay ledger in memory. POSIX only. Not a sandbox. | Shipped | `test/adapters.test.ts`, `test/fixtures/process.mjs` |
| `pi.ts` | `pi({ readBrief, idleMs, models, env, args })` | Verifies the brief digest, writes a private task file, runs `pi-task <task-file> [max-seconds]` with `PI_MODEL`, tries the next model on an eligible failure in one wall deadline. No live stdin. `pi-task` itself is not in this repo. | Shipped as an adapter. Depends on an external launcher. | `test/adapters.test.ts`, `test/fixtures/pi-task.mjs` |
| `runner.ts` | `runTask({ board, taskId | selection, harness, work, usageGuard, capacity, pollMs })` | Claims, renews, watches `pauseEpoch`, runs the harness, releases. Never completes or fails the task. Returns `lease_lost`, `paused`, `usage_blocked`, `capacity_unavailable`. | Shipped | `test/runner.test.ts` |
| `usage.ts` | `usageGuard`, `localUsage({ file } | { command, args })` | Blocks dispatch at 95% of the five-hour window until `resetAt`. Reads a JSON file or a trusted command. Nothing wakes at reset. No weekly window. | Shipped | `test/usage.test.ts` |
| `capacity.ts` | `capacity({ limits, heavy: { directory, slots } })` | Per-kind slots (`worker`, `build`, `qa`, `review`) in process, host-wide heavy slots as lock directories | Shipped | `test/capacity.test.ts` |
| `stall.ts` | `stallWatcher(team, { channel, to, now, quietMinutes, periodMinutes })`, `heartbeat`, `nextBeat` | Token-free check of feed silence and missed registry heartbeats; sends one operational-inbox message per topic. Cursor and dedupe in memory. | Shipped (#37). The caller must loop it. | `test/stall.test.ts` |
| `names.ts` | `namePool` (33 names), `pickName(inUse)`, `spawnerTitle(tag, name)` | Spawner name pool. No atomic reservation. | Shipped (#33). Secretary, mob species and sprite item pools are not in code. | `test/names.test.ts` |
| `controller/index.ts` | `runController({ board, agent, roles, parentOf, clock, signal, wake })` | Follows the event long-poll, reads `operationalInbox`, records `seen`, calls `wake`, records `acted`, escalates a reference to the parent at a deadline. No checkpoint. Single instance. | Shipped (#23) | `test/controller.test.ts` |
| `router/contract.ts`, `route.ts` | `createRouter({ scoreboard, models, maxAttempts, cooldownMs, probeTimeoutMs, execute })`, `AttemptContract` | Ranks provider and model pairs by `quality`, `cost` or `latency`; freezes the contract; retries by failure class; in-memory cooldowns; one auth probe. Host supplies `execute`. | Shipped (#16). No real executor exists. | `test/router.test.ts` |
| `router/scoreboard.ts` | `boardScoreboard({ board, channel, author })`, `registerScoreboardSchema` | Keeps `runtime-attempt@1` blocks in a channel; reads the latest 100; dedupes by attempt ID | Shipped | `test/router.test.ts` |
| `remote/ref-store.ts` | `localGit({ repoDir, identity })`, `RefConflict`, `RefStoreError` | Compare-and-set text files (64 KiB) on `remote/<agent>/{brief,control,inbox,status}` branches. Never fetches or pushes. | Shipped (#18) | `test/remote-git.test.ts` |
| `remote/watcher.ts` | `watchRemote({ refs, host }).poll(...)`, `checkFor` | On `status.json` `{"state":"finished"}`, opens or reuses a draft PR and reads checks for the exact head | Shipped as a function. Nothing calls it on a schedule. | `test/remote-review.test.ts` |
| `remote/code-host.ts`, `gh.ts`, `cli.ts` | `ghCodeHost({ repo, base, requiredCheckNames, token, withHeadLock })`, `execCli` | GitHub adapter over the `gh` CLI. Refuses `readiness_unfenced` without `withHeadLock`. | Shipped | `test/remote-gh.test.ts` |
| `remote/gate.ts` | `reviewGate({ host, key, checkFor, verdictsFor }).markReadyIfAllowed(pr)`, `signVerdict` | Marks a PR ready only with passing checks and an HMAC-signed clean verdict on the current head. Never merges. No severity level. | Shipped | `test/remote-review.test.ts` |
| `ops/refill.ts` | `refill(board, { channel, agent, threshold, max })` | When ready count is below threshold, creates up to 15 tasks blocked `awaiting_approval`. The caller supplies the drafting agent. | Shipped | `test/ops/refill.test.ts` |
| `ops/packets.ts` | `writeResumePacket`, `readResumePacket`, `appendAttempt`, `readAttempts` | Resume packets and an attempt ledger as plain files | Shipped | `test/ops/packets.test.ts` |
| `ops/privacy.ts` | `scanDiff`, `preflight` | Refuses added diff lines with tokens, keys or emails | Shipped | `test/ops/privacy.test.ts` |
| `ops/scaffold.ts` | `createInstance(dir, { name })`, `runCreateInstance(argv)` | Writes a self-hosted instance directory with no credentials | Shipped | `test/ops/scaffold.test.ts` |

## 2. Capability catalogue

| ID | Capability | Where | Maturity | How to test |
| --- | --- | --- | --- | --- |
| PB-01 | A task is a thread root with one of seven board-kept states (`waiting`, `ready`, `claimed`, `blocked`, `completed`, `failed`, `canceled`) under the reserved `board.task` label. | `src/server/tasks.ts`, `vb tasks create|show`, `team.tasks.*` | Shipped | `packages/board/test/tasks.test.ts`, `cli-tasks.test.ts` |
| PB-02 | A claim is a lease to one actor; each claimed write carries `epoch` and `token`, and a stale write fails 409 `claim_lost`. | `POST /tasks/:id/claim`, `/renew`, `/release`; `vb tasks claim --lease`, `renew`, `release`; `src/cli/claims.ts` keeps receipts under `XDG_CONFIG_HOME` | Shipped | `cli-tasks-claims.test.ts`, conformance group `tasks` |
| PB-03 | Claim-next takes the highest of five priorities, then a task assigned to the caller, then the oldest, and can wait for one. | `POST /tasks/claim`, `vb tasks claim --ready <channel> --label k=v --wait 10m`, `vb tasks priority` | Shipped (#11) | `tasks.test.ts`, `http-task-authority.test.ts` |
| PB-04 | A task waits for prerequisites (`needs`) and becomes ready when all complete; a plan of tasks is one atomic, idempotent write. | `POST /tasks/batch`, `POST /tasks/:id/needs`, `vb tasks create --needs`, `--file plan.json --idempotency-key` | Shipped | `tasks-batch.test.ts`, `cli-tasks-batch.test.ts` |
| PB-05 | A claim can carry a binding (`controller`, `owner`, `provider`, `model`, `session`, `branch`, `worktree`, `baseCommit`); the board checks only that `owner` is the claimant. | `vb tasks claim --binding '<JSON>'`, `src/api/task-authority.ts`, discovery `task_authority` | Shipped (#19), local only | `task-authority.test.ts`, `cli-task-authority.test.ts` |
| PB-06 | A live claim can append an immutable handoff record (commit, packet path, SHA-256, optional supersedes) shown as `TaskView.handoff`; it moves no state. | `POST /tasks/:id/handoff`, `vb tasks handoff` | Shipped (#19) | `task-authority.test.ts` |
| PB-07 | `vb tasks run` claims a task, runs a command with `BOARD_TASK`, renews, and settles by exit code. | `src/cli/run.ts` | Shipped | `cli-tasks.test.ts` |
| PB-08 | A plain hold (`block --kind needs_input|awaiting_approval`) ends the lease; the owner lifts it. | `vb tasks block|unblock` | Shipped | `tasks.test.ts` |
| PB-09 | Structured attention: a question with 2 to 8 options bound to a commit string; a listed responder answers once; stale answers are refused 409 `attention_stale`. | `vb tasks ask|attention|answer`, `src/contract/attention.ts`, `local({ attentionResponders })` | Shipped (#10), local only | `task-attention.test.ts`, `cli-task-attention.test.ts`, `task-attention-feed-watch.test.ts` |
| PB-10 | Operator park and unpark by a verified person with `manage`; park ends the lease and `unblock` cannot lift it. | `vb tasks park|unpark` | Shipped (#19) | `task-authority.test.ts` |
| PB-11 | Network pause: one switch advances `pauseEpoch`, invalidates leases, and makes claims 409 `board_paused`; resume revives none. | `vb status|pause|resume`, `/control/*`, `initiallyPaused` | Shipped (#13, #25, #57) | `network-pause.test.ts`, `cli-network-pause.test.ts` |
| PB-12 | Labels are key=value on messages with compare-and-set (`if`), 409 `label_conflict` on a lost race; reads, events and tasks filter by `key`, `key=value`, `key=a|b`. | `POST /messages/:id/labels`, `vb label --if k=v --if-unset k` | Shipped (upstream) | `label-if.test.ts`, `label-values.test.ts` |
| PB-13 | Post idempotency: a caller-supplied `id` makes a retried post land once; `GET /posts/:id` finds it. | `PostBody.id`, `vb post --idempotency-key` | Shipped | `post-id.test.ts` |
| PB-14 | Conditional reply: `after` refuses with 409 `newer_message` if the thread moved. | `vb reply --after` | Shipped | `reply-after.test.ts` |
| PB-15 | Schemas and blocks: a registry of immutable JSON Schema versions; `board()` rejects a write whose `json#name@v` block fails its schema (400 `invalid_block`, `schema_not_found`). | `team.createSchema`, `vb schemas create`, `vb post --schema`, `src/contract/{blocks,data-schemas,data-values}.ts` | Shipped (upstream) | `schemas.test.ts`, `message-blocks.test.ts`, `cli-blocks.test.ts` |
| PB-16 | Event feed with long-poll (`wait` up to 300 s), cursor (`after`), newest N (`last`), label filters, and SSE. | `GET /events`, `team.events`, `vb tail`, `vb wait <channel|id> --mentions --re --after --timeout` | Shipped | `events-last.test.ts`, `events-state.test.ts`, `cli.test.ts` |
| PB-17 | Watchers: a named tail expression whose matches the board queues and delivers with retries, by wake URL or by pull. | `board({ watch })`, `POST /watchers`, `GET /watchers/matches`, `/ack` | Shipped (upstream). `vb serve` itself mounts none; a client on `http()` registers and pulls. | `watch.test.ts`, `http-watchers.test.ts` |
| PB-18 | Scheduled messages: once or repeating (`in`, `at`, `every`, `until`, `for`, `times`), posted as their creator. | `vb schedule <thread> "<text>" --every 30m --at ...` | Shipped. In-process timers on `local()`. | `schedules.test.ts` |
| PB-19 | Attachments: upload, chunked upload, download; files live beside the SQLite file. | `POST /attachments`, `vb post --attach`, `vb download` | Shipped | `attachments.test.ts`, `http-files.test.ts` |
| PB-20 | Identity: every write records a verified principal and an optional self-chosen profile (`--as`, `BOARD_PROFILE`); profiles carry no credential. | `src/server/{auth,identity,actors}.ts`, `vb whoami` | Shipped | `access.test.ts`, `as-can.test.ts` |
| PB-21 | Grants: channel-pattern permissions (`read`, `post`, `react`, `label`, `sync`, `manage`) for users, projects, GitHub workflows, any OIDC issuer; `explain` says why. | `vb grants *`, `/grants*` | Shipped | `grants.test.ts`, `access-exhaustive.test.ts`, `cli-grants.test.ts` |
| PB-22 | Invites: a single-use secret gives a named member a stored bearer credential and a grant on a self-hosted board, with no Vercel login. | `vb invite create <name> --out f --can 'work=read,post' --expires-in s`, `vb join <url> -` | Shipped (#24), local only | `cli-invites.test.ts`, `invite-boundaries.test.ts` |
| PB-23 | Team tokens: one 64-hex token per handle from a file names `team:user:<handle>`; API only, behind a TLS proxy. | `vb serve --team-tokens f --allow-host h --host ip` | Shipped (#17) | `serve-team.test.ts`, `trusted-team.test.ts` |
| PB-24 | Tailnet mode: Tailscale names the caller as `tailscale:user:<login>` with no token. | `vb serve --tailscale <name>`, `src/cli/tailscale.ts` | Shipped (upstream) | `serve.test.ts`, `host-access.test.ts` |
| PB-25 | `vb serve` runs a `local()` board at `127.0.0.1:4100/api/board` with SQLite, files, scheduler and the inspector. | `src/cli/serve.ts`, `src/server/serve.ts` | Shipped | `serve.test.ts`, `smoke-e2e.test.ts` |
| PB-26 | `vb serve --swarm` turns on agent ops and structured attention, makes the local owner the responder, and advertises `politburo: 1` in discovery; refused with `--team-tokens`. | `src/cli/swarm.ts` | Shipped (#59) | `swarm-serve.test.ts` |
| PB-27 | `vb serve --responder <principal>` adds attention responders for all channels. | `src/cli/swarm.ts` | Shipped (#62) | `responder-serve.test.ts` |
| PB-28 | Politburo quickstart doc: serve, invite a responder, ask and answer. | `packages/board/docs/01-board/10-local.md`, `README.md` | Shipped (#63) | `docs.test.ts`, `docs-links.test.ts` |
| PB-29 | Agent registry: an entry per binding per exact channel with one of eight roles, an optional same-channel parent, harness, generation, status, `heartbeatAt`. Roles grant nothing. | `vb agents list|register|heartbeat|retire`, `src/server/agents.ts`, `local({ agentOps: true })` | Shipped (#12), local only | `agents.test.ts`, `cli-agents.test.ts`, `http-agent-ops.test.ts` |
| PB-30 | Command intents: `inspect`, `status`, `pause`, `interrupt`, `resume`, `collect`, `poke`, generation-bound, TTL 1 to 60 s, one take, pull-only. | `vb agents issue-intent|issue-role-intent|intents|take-intent|report-intent`, `src/server/agent-intents.ts` | Shipped (#22). The board records them and executes nothing. | `agent-intents.test.ts` |
| PB-31 | Run health: `working until <t>` only when the newest reported probe for the live claim says `running` within a 30 s window, else `stale`. | `vb agents health <task>`, `GET /ops/health/:task` | Shipped (#22) | `agent-intents.test.ts` |
| PB-32 | Operational inbox: private mail to a principal ID or a configured role, with topic supersession, optional `expiresAt`, `seen` and `acted` receipts, archive, reads capped at 15, no feed events. | `team.operationalInbox`, `vb inbox read|ack|archive`, `/operational-inbox*`, `board({ inboxRoles })` | Shipped (#9). Send is SDK or HTTP only. | `operational-inbox.test.ts`, `cli-operational-inbox.test.ts` |
| PB-33 | Attention inbox view with keyboard answer. | Inspector `/attention` | Shipped (#53) | `attention-keys.test.ts`, `inspect-workbench.test.tsx` |
| PB-34 | Pause banner, pause control and acting-as identity in the inspector. | `app/App.tsx` | Shipped (#57) | `inspect-buttons.test.ts`, `inspect-page.test.ts` |
| PB-35 | Flagged claim requests refuse redirects so a 307 cannot forward a claim token. | `src/client/client.ts`, `src/server/backend-http.ts` | Shipped (#52, #56) | `claim-redirect.test.ts`, `claim-redirect-hardening.test.ts` |
| PB-36 | Seeded deterministic simulation of lease, access and claim-file races. | `packages/board/test/dst` | Partial (#54): runs on main, most experiments pending | `DST_SEEDS=300 pnpm --filter @vercel/board exec vitest run test/dst` |
| PB-37 | Fork-thinness and time-to-first-claim judges. | `tools/metrics` | Shipped (#55), outside `pnpm check` | `node --test tools/metrics/test/` |
| PB-38 | `bench-run@1` measurement record design, kept in a `bench` channel as blocks. | `design/benchmarks.md` | Design only (#64). No collector. | none |
| PB-39 | Conformance kit any backend can run, with opt-in groups `tasks`, `network-pause`, `agents`, `operational-inbox`, `task_attention`. | `@vercel/board/conformance`, `vb conformance` | Shipped | `conformance.test.ts` |
| PB-40 | Agent hooks: install hooks into claude, codex, cursor or pi so the agent sees board mentions. | `vb hooks`, `vb hook`, `src/cli/hooks.ts` | Shipped (upstream) | `cli-hooks.test.ts` |
| PB-41 | Sync: Slack, GitHub and Linear threads mirrored both ways; a PR root carries `pr`, `head`, `state`, `review`, `ci.*` labels. | `@vercel/board/sync-*` | Shipped (upstream). Needs an app-mounted board and Vercel Connect; not on `vb serve`. | `sync.test.ts` and platform tests |
| PB-42 | Harness interface and three adapters (`fake`, `subprocess`, `pi`). | `packages/runtime/src/{harness,fake,subprocess,pi}.ts` | Shipped. `codex-cli` and `claude-cloud` are names with no adapter. | `packages/runtime/test/adapters.test.ts` |
| PB-43 | Lease-aware runner that never settles a task. | `runTask` | Shipped (#8, #25) | `packages/runtime/test/runner.test.ts` |
| PB-44 | Usage guard at 95% of the five-hour window. | `usageGuard`, `localUsage` | Shipped | `test/usage.test.ts` |
| PB-45 | Capacity slots per kind and host-wide heavy slots. | `capacity` | Shipped | `test/capacity.test.ts` |
| PB-46 | Stall watcher and heartbeat grid. | `stallWatcher`, `heartbeat`, `nextBeat` | Shipped (#37) | `test/stall.test.ts` |
| PB-47 | Controller loop: wake on inbox mail, receipts, escalate to parent. | `runController` | Shipped (#23) | `test/controller.test.ts` |
| PB-48 | Routed attempts with a board-kept scoreboard. | `createRouter`, `boardScoreboard` | Shipped (#16), no real executor | `test/router.test.ts` |
| PB-49 | Git-ref exchange for remote agents. | `localGit` | Shipped (#18) | `test/remote-git.test.ts` |
| PB-50 | Remote watcher that opens a draft PR on `finished` and reads checks on the head. | `watchRemote`, `ghCodeHost` | Shipped as a function, no loop | `test/remote-review.test.ts`, `remote-gh.test.ts` |
| PB-51 | Review gate: ready only with green checks and a signed clean verdict on the same head. | `reviewGate`, `signVerdict` | Shipped. No merge, no severity. | `test/remote-review.test.ts` |
| PB-52 | Refill: draft up to 15 proposed tasks held for approval. | `refill` | Shipped | `test/ops/refill.test.ts` |
| PB-53 | Resume packets and attempt ledger as files. | `ops/packets.ts` | Shipped | `test/ops/packets.test.ts` |
| PB-54 | Privacy preflight on a diff. | `scanDiff`, `preflight` | Shipped | `test/ops/privacy.test.ts` |
| PB-55 | Instance scaffold with no credentials. | `createInstance`, `runCreateInstance` | Shipped | `test/ops/scaffold.test.ts` |
| PB-56 | Spawner name pool. | `namePool`, `pickName`, `spawnerTitle` | Shipped (#33) | `test/names.test.ts` |
| PB-57 | End-to-end smoke test of the main CLI flows against a spawned board. | `packages/board/test/smoke-e2e.test.ts` | Shipped (#36); hardening open in #39 | that file |

### Open PRs on the fork

| PR | Title | State | What it adds |
| --- | --- | --- | --- |
| #45 | feat: add a decisions tool on board threads and labels | Open | `tools/decisions/decisions.mjs`: ask, list, answer owner decisions with `vb post`, `label --if`, `reply`, `wait`. A working example of mail-like records on threads and labels. Not in `pnpm check`. |
| #44 | feat(inspector): add the swarm queue and mobs views | Draft | `/swarm/queue` and `/swarm/mobs` from tasks alone (phase 1 of the frontend design). |
| #39 | test: strengthen the 33, 36 and 37 follow-ups | Open, review FAIL | Test-only hardening of names, stall and smoke. One blocking finding open on the smoke credential check. |
| #21 | feat(protocol)!: add opt-in task lifecycle stages | Open, conflicting, held | `vb tasks scope|stage`, staged `reopen`, `task.stage_changed`, access fence (`store/fence.ts`). Breaking for custom backends. |
| #20 | feat(protocol): gate task completion on commit evidence | Open, conflicting, held | `vb tasks submit|evidence|attest|override|resolve`, `store/append-guard.ts`, `/work/v1/...`. Held on security findings. |

### Merged on the fork (titles, newest first)

#64 bench-run@1 design; #63 quickstart docs; #62 `vb serve --responder`; #59 `vb serve --swarm`; #58 hill-climb design; #57 pause banner and acting-as; #56 and #52 claim redirect fixes; #55 metrics judges; #54 DST harness; #53 Attention view; #48 and #42 upstream merges (to 0.54.0); #47 disable publishing; #43 test follow-ups; #38 DST design; #37 stall watcher and heartbeat; #36 e2e smoke; #35 swarm architecture docs; #34 swarm frontend design; #33 name pool; #32, #31, #30 conformance and protocol fixes; #29 and #26 Tigeryard parity integrations; #28 pause CLI wording; #27 docs; #25 runtime honors pause and priority; #24 invites; #23 controller loop; #22 health and intents; #19 holds and bound claims; #18 git-ref remote work and review gate; #17 self-host for a team; #16 router; #13 network pause; #12 agent registry; #11 priorities; #10 human attention; #9 operational inbox; #8 harness and runner; #7, #6, #5 design docs.

## 3. Swarm concepts already designed

**`design/swarm-architecture.md`** (proposed). Decides four tiers (core, spawner, mob, sprite), one secretary per spawner as a convention, work shares (0.5 / 4.5 / 15 / 75 percent), the authority table, the merge guardrail (green CI on the exact head, latest review on that head, nothing above minor), dispatch, the two-failure rule for sprites, push paths, reports, human gates. Built: every board primitive it cites (tasks, bindings, handoff, attention, park, pause, registry, schedules) and the runtime pieces (`runTask`, `pi()`, `usageGuard`, `capacity`, `reviewGate`, `runController`). Not built: anything that launches a spawner, secretary, mob or sprite; class enforcement; the serial counter. It says the pi model router (three tiers, 30-minute cooldown, `PI_*` variables) lives in the `pi-task` launcher's `fallback/codex-cursor` extension, "not the runtime package". Thirteen questions are "To be confirmed", including who starts core and secretary sessions and how tiers map to registry roles. Note: this doc says the secretary relays through the operational inbox, which contradicts the two docs below.

**`design/swarm-secretaries.md`** (proposed). Decides the mail format, seven classes (`sec.push`, `sec.retry`, `sec.retire`, `sec.log`, `spawner.dispatch`, `spawner.decide`, `core.escalate`), the urgency routing table (p0 now, p1 within 10 minutes, p2 in the 30-minute digest, p3 log), the digest shape, and the transport: a thread root in `swarm/<tag>/inbox` labeled `swarm.class`, `swarm.urgency`, `swarm.state` with a `swarm-message@1` block, taken with a compare-and-set label write. It says "The swarm leaves the board's operational inbox unused." Built: nothing in code (no `swarm-*` schema or label appears in any source file). The token-free router script is called "a session convention, not a board feature".

**`design/swarm-naming.md`** (proposed). Decides titles (`<TAG> <NAME>`, `<tag> <serial>-<SPECIES><n>`, `<mob-id>.<ITEM><n>`), four classes (Passive, Neutral, Hostile, Boss) as remote ceilings, species per job, items per sprite job. Built: only the spawner pool (`packages/runtime/src/names.ts`). Not built: secretary names, species and item tables, serial allocation. The board enforces no class.

**`design/mob-retirement.md`** (proposed). Decides the retirement checklist (all work on `origin`, clean worktrees, no running sprite) and the board steps (`vb agents retire <agent> --generation <n>`, archive the session outside the board). Built: `agents retire`. Not built: any check; the board cannot see Git. A spawner cannot retire a mob's entry as itself, since retire must match the entry's principal and profile.

**`design/swarm-frontend.md`** (proposed, nothing built except phase 1 in draft #44). The most useful doc for the merger. It maps every stack concept to a board piece with a fit rating, defines nine block schemas (`swarm-message@1`, `swarm-digest@1`, `swarm-pr@1`, `swarm-report@1`, `swarm-repo@1`, `swarm-sprite@1`, `swarm-status@1`, `swarm-beat@1`, `swarm-retire@1`), and lists gaps G1 to G15 with an owner for each. Gaps it assigns to `packages/runtime`: G3 verdict severity, G4 stall flag as a `swarm-message@1`, G8 a `mirror` module from git status refs to `swarm-status@1` replies, G9 a long-running watcher loop, G13 a `digest` module, G15 router state. Gaps it assigns to the spawner or secretary tooling "outside this repo": G10 mob observation, G11 beats, G12 serial and check lock, G14 retirement evidence. G7 (how a cloud mob reaches the board) is a "deployment decision". Fourteen owner questions are open, including Q1 (where the board runs and who can reach it) and Q7 (YAML or JSON header).

**`design/runtime-package.md`** (first slice shipped). Decides a separate package on the public handle. Built: harness, three adapters, runner, router, policies, remote work, gate, controller, ops. Not built: `/runtime` routes, managed lifecycle, `codex-cli` and `claude-cloud` adapters, wake at usage reset, slot expiry, reuse of the swarm and factory templates.

**`design/work-lifecycle.md`** (partly shipped). Built: priority, bound claims, handoff, park, pause. Not built (held in #20 and #21): scope-before-claim, stages after completion, evidence gates, evidence-released dependencies, role checks, the task history route. `complete` still releases dependents with no evidence.

**`design/agent-registry-roles-inbox.md`** (shipped with changes in #9, #12, #22, #30). Built: registry, eight roles as duties, operational inbox, intents, health. Changed from the proposal: mail is board-wide and not addressed by registry ID; no archive folder, no cursor paging, no `GET /deliveries/:id`.

**`design/human-attention.md`** (shipped in #10 with changes). Built: ask, attention, answer, responder list as a deployment setting. Not built: channel caps on request lifetime, surfacing expired requests, lifecycle-generation cases.

**`design/deterministic-simulation.md`** (proposed; spike merged as #54). Decides seeded simulation with history oracles. Says a separate swarm stack can reuse the driver pattern, not board's storage or policy. Rejects Antithesis because it is paid.

**`design/hill-climbs.md`** (proposed). Defines four climbs: failing seeds, time to first claim, fork thinness, agent cold-start success. Judges for two are on main. Fork thinness matters for the merger: new code in `packages/board/src` counts against it.

**`design/benchmarks.md`** (proposed, #64). Defines `bench-run@1` from sprite logs that `pi-task` and `sprite-start` leave under `/tmp/sprites`. It ends with a direct request to Tigeryard: have `pi-task` and `sprite-start` log a `git diff --numstat` summary, an explicit attempt number, and a machine-readable exit reason. So the design treats `pi-task` and `sprite-start` as Tigeryard-owned.

**What the designs expect from Tigeryard or outside tooling.** The `pi-task` and `sprite-start` launchers and the pi fallback extension; the secretary's token-free header router; the spawner's 30-minute beat and mob dispatch; serial allocation; retirement checks on the mob's VM; `swarm-pr@1` snapshots from the code host. None of the designs name a split between "two spawners"; the only explicit handoff to Tigeryard is the benchmarks request.

### TIGERYARD-PARITY.md: summary and accuracy

It is an intent document audited on 2026-11-19 at `ca9333d9` (0.53.0) against Tigeryard 0.3.1. It lists what to keep, five gap groups, a do-not-port list, an order, and open decisions. The README says it "records what to build, not what exists".

As a status document it is stale. Checked against code at `b146e75b`:

| Parity gap | Status in code today |
| --- | --- |
| 1 Scope before work, post-completion stages, evidence gates, evidence-released dependencies | Not on main. Held in #20 and #21. |
| 1 Five priorities, claim-next by priority | Shipped (#11). Levels are names, not 1 to 5. The owner or `manage` may raise; a live claim may only lower. |
| 1 Assignment binding, generation fence | Shipped (#19). The lease `epoch` is the generation. |
| 1 Immutable handoffs | Shipped as metadata only. |
| 1 Network pause | Shipped (#13). A board starts running, not paused, unless `initiallyPaused`. |
| 1 Operator block | Shipped as park and unpark. |
| 2 Human attention | Shipped (#10). No evidence list; the commit is a string the board does not check. |
| 3 Agent registry, eight roles | Shipped (#12), opt-in, local only. |
| 3 Operational inbox | Shipped (#9) in a different form. |
| 3 Health observations, command intents | Shipped (#22). |
| 4 Eight-column board, "why isn't this running", health, review queue, provider access, scoreboard pages, paged history | Not built. Main has Handoffs, Presidium, Tasks, Attention. Queue and mobs in draft #44. |
| 5 Harness interface | Shipped. Adapters: `pi`, `subprocess`, `fake`. No Codex CLI or Claude cloud adapter. |
| 5 Routed attempts, scoreboard, access probe | Shipped as a library with a host-supplied executor. |
| 5 Controller sessions | Shipped as `runController`. |
| 5 Usage guard | Shipped. No wake at reset. |
| 5 Capacity | Shipped. |
| 5 Remote work over git refs, watcher, review gate | Shipped as functions. No loop runs them. |
| 5 Issue refill | Shipped; the drafting agent is the caller's. |
| 5 Resume packets, attempt ledger, scaffold, privacy scan | Shipped. Cost reporting is not. |

Other inaccuracies: the line "The board package has none of this" under Runtime is true of `packages/board` but hides that `packages/runtime` now exists. The "Roles conflict with the spec" decision is resolved (roles are duties, not grants). "Where the runtime lives" is resolved (separate package). `design/agent-registry-roles-inbox.md` links to `../briefs/pb-1-TIGERYARD-PARITY.md`, a path that does not exist in the checkout. The doc also predates the whole swarm tier model (core, spawner, secretary, mob, sprite): it describes Tigeryard's older controller and worker roles, so it is incomplete as a map of today's swarm runtime (remote watcher, secretary mailbox, pi router setup, skills are only partly named).

## 4. Messaging fit

Short answer: yes, on threads, labels and blocks, as `design/swarm-secretaries.md` and `design/swarm-frontend.md` already decide. The operational inbox is the wrong carrier. Nothing is implemented yet; PR #45 (`tools/decisions`) proves the pattern end to end with the CLI.

| Mail feature | Board primitive | Fit | Notes |
| --- | --- | --- | --- |
| `id` | The board message ID, plus a sender key as `PostBody.id` (`vb post --idempotency-key`) | Covered | The board ID is assigned on write. A sender-chosen ID like `ex-0412` goes in `PostBody.id` or a label. |
| `class` | Label `swarm.class=<class>` on the thread root | Covered | Filter: `team.threads({ label: ['swarm.class=sec.push'] })`, `vb read <ch> --label`. `a|b` values work on local; Vercel's board indexes one value only. |
| `urgency` p0 to p3 | Label `swarm.urgency` | Covered | Separate from task `Priority`. |
| `from` | Board-authored `by` (principal and profile) is authoritative; the display label goes in the block | Covered | A mob that cannot reach the board has the secretary post for it, so `by` is the secretary. |
| `to`, mailbox per recipient tag | A channel per mailbox (`swarm/<tag>/inbox`, `swarm/core/inbox`); channel grants scope who reads | Covered by convention | No per-recipient addressing inside a channel except mentions (`vb read --mentions`, `vb wait --mentions`) or a `swarm.to` label. |
| `summary` at most 120 | `swarm-message@1` schema with `maxLength: 120` | Covered | `checkDefinition` allows length bounds. |
| Body pointer | Block field `body` naming a reply ID or attachment; body as a reply in the thread or `POST /attachments` | Covered | Header-only reads: `GET /threads` returns roots; replies load only on `GET /messages/:id`. |
| `at` | Message timestamp | Covered | |
| YAML header | Blocks are JSON only (`json#name@version`) | Gap (format) | Frontend Q7. YAML text would be stored but not validated or parsed. Use JSON. |
| Routing by class and urgency | Client-side: a token-free loop over `GET /events?wait=` with label filters, or a watcher tail | Gap (code) | No router exists. The routing table (p0 now, p1 10 minutes, p2 digest) is not on the board. `AGENTS.md` "No pre-AGI mechanisms" bars keyword guessing in board code; routing by explicit labels the sender set is not guessing, but it belongs in `packages/runtime`, not `packages/board`. |
| Digests | A message with a `swarm-digest@1` block, once per window, deduped by a label set with `if` absent or a deterministic `PostBody.id` | Gap (code) | Frontend G13: a `digest` module in `packages/runtime/src/ops`. A 30-minute trigger can be `vb schedule ... --every 30m` plus a watcher, or the secretary's own loop. |
| Dedupe | `PostBody.id` (post once), `label --if` (take once, 409 `label_conflict`) | Covered | Scope of `PostBody.id` uniqueness should be confirmed in `test/post-id.test.ts`. |
| Handled state | Label `swarm.state` `open` to `handled` or `forwarded` with `if` | Covered | |
| Expiry | Nothing on messages | Gap | Only the operational inbox has `expiresAt`. Options: an `expiresAt` block field checked by the reader, or `team.delete`. |
| Rejected on schema fail | `board()` checks every block before the backend: 400 `invalid_block` or `schema_not_found`, nothing written | Covered, with a limit | Only fenced blocks are checked. A message with no block is accepted. Labels are not schema-checked (any `[a-z0-9._-]` key, value up to 256). Nothing forces a post in `swarm/<tag>/inbox` to carry a `swarm-message@1` block; a `middleware` on an app-mounted board could, but `vb serve` exposes no middleware option. |
| Atomic file writes | One conditional append to the SQLite log per write | Covered (stronger) | |
| Token-free wake on new mail | `vb wait <channel> --label swarm.urgency=p0 --timeout 30m`, `vb tail --json`, `GET /events?wait=300`, SSE, or `runController` (operational inbox only) | Covered | `vb wait` sees only what comes after it starts; read first, then wait with `--after`. Long-poll caps at 300 s per request. |
| Receipts (seen, acted) | Labels, or reactions | Partial | Real per-principal `seenAt` and `actedAt` exist only on the operational inbox. |
| Escalation to parent | `core.escalate` class, or `runController` deadline escalation | Partial | `runController` works on the operational inbox, which the secretaries doc leaves unused. It would need a thread-and-label variant. |
| Counting `sec.log` without reading bodies | `GET /threads` with label filter, count roots | Covered | No count endpoint; page and count. |

Why not the operational inbox (`team.operationalInbox`): a newer send to the same recipient and topic replaces the older one, reads return 15, there is no history, no feed event (the reader must poll), no labels, and Vercel answers 501. It suits wake-ups and stall flags (`stallWatcher` uses it), not a mailbox with digests.

Why not tasks for mail: a task is a unit of work with a lease. Use tasks for `sec.push` style work if exclusive handling with expiry is wanted (a lease lapses; a label does not), as frontend G12 suggests for the check lock.

Real gaps to build: (1) register the `swarm-*@1` schemas (a helper in `packages/runtime`); (2) a header router loop; (3) a digest module; (4) expiry; (5) enforcement that inbox posts carry a valid header; (6) a `vb`-level send for mail is fine (`vb post --schema swarm-message@1 --label ...` works today), so no new CLI is strictly required; (7) settle the contradiction between `swarm-architecture.md` (operational inbox) and `swarm-secretaries.md` (threads).

## 5. Self-hosting facts

- **Command.** `vb serve` (from a build: `node packages/board/dist/cli.mjs serve`). It runs `board({ backend: local() })` in one Node 22.18+ process. No Vercel account, no paid service.
- **Storage.** SQLite at `<dir>/local.db` with attachments in `<dir>/local/`. `<dir>` is `.board/` at the Git checkout root, or `--dir`. A named board is `<dir>/<name>.db`. The log, tasks, grants and files survive restarts. Schedule timers do not; a pending send can show as due and never send.
- **Listen address.** `127.0.0.1:4100`, mount `/api/board`. The inspector is served on the same port unless `--no-inspect`. `--host` takes a specific IP and only with `--team-tokens`. `0.0.0.0` is refused.
- **Owner auth.** At start `serve.ts` generates an ES256 key pair, verifies tokens from issuer `board:local` against it, signs the operator a 30-day JWT as `local:user:<OS user>`, and writes it to `localTokenFile(url)` under `XDG_CONFIG_HOME/.../local/<hash>.json`. The CLI uses that file only for loopback URLs. The key pair is per start.
- **Three ways to let others in.**
  1. Invites (`vb invite create <name> --out f --can '...'`, `vb join <url> - < f`): the board stores a member credential and a grant. Works for agents and people. Cannot grant `manage`. The CLI accepts plain HTTP only on loopback, so a remote member needs HTTPS.
  2. Team tokens (`vb serve --team-tokens tokens.json --allow-host board.example.com`): one 64-hex bearer per handle, `team:user:<handle>`. API only, no inspector, read once at start. Cannot combine with `--swarm` or `--tailscale`.
  3. Tailscale (`vb serve --tailscale box.tailnet.ts.net` plus `tailscale serve --bg 4100`): callers are `tailscale:user:<login>`, no token. Free plan works within its limits.
- **How a cloud session elsewhere reaches it.** The operator must supply the network path. Options in the docs: a TLS reverse proxy (Caddy example) with `--allow-host <name>` and `X-Forwarded-Proto: https`, then `BOARD_URL=https://<name>/api/board` and a `BOARD_TOKEN` (team token) or a joined credential; or a tailnet, which requires the cloud VM to be on the tailnet. `--allow-host` starts no proxy and no TLS. The frontend design's G7 and Q1 leave this open: "A cloud mob cannot reach a local board by default".
- **Swarm mode.** `vb serve --swarm` = `agentOps: true`, `attentionResponders: { '*': [owner] }`, discovery `politburo: 1`. Add `--responder <principal>` per extra responder.
- **Default grant.** Grant `g1` gives every person full access including `manage`. Narrow it before inviting. Profiles (`--as`) distinguish writers, not permissions: all agents under one OS user or one token are the same principal.
- **Limits.**
  - One process, one SQLite file, one machine. No replication. DST notes the access fence is in-process and multi-process is untested.
  - `vb serve` mounts no sync and no watchers of its own. GitHub or Slack sync needs an app-mounted board with Vercel Connect, which is a Vercel service.
  - `--swarm` and `--team-tokens` are mutually exclusive, so the documented team mode cannot be a swarm board today. A remote swarm board must use invites behind your own proxy, or Tailscale.
  - With `--allow-host`, anyone who reaches the inspector at the proxy name acts as the owner, including answering attention. Keep the inspector private.
  - Offboarding a team token needs a file edit and restart.
  - Backups: stop the server, copy the whole `--dir`.
  - Registry lists are per exact channel and unpaged. Registry and inbox facts never reach `/events`.

## 6. Constraints from AGENTS.md that a merger must respect

- **Layering.** API, then `board()`, then CLI. The CLI makes no HTTP calls of its own. `board()` calls only backend methods. Policy lives in `board()` in one place.
- **Package boundary.** "nothing in `packages/board` imports" `packages/runtime`. The runtime uses only the public handle, never tables or A2 (`design/runtime-package.md`).
- **No pre-AGI mechanisms.** No hard-coded keyword or emoji triggers, canned decorations, or heuristics that guess meaning and rewrite a message. Deliver what the author wrote. This shapes the mail router: route on explicit sender-set fields only.
- **Erasable TypeScript only** (`erasableSyntaxOnly`): no enums, namespaces or parameter properties. Tests run the CLI from source with Node type stripping.
- **One log.** On a local board every board fact is an event in A2 session `board`. Bookkeeping people do not read goes in side contracts. Folds mutate in place. Provenance (`by`, `mentions`, sync fields) is server-authored, never read from a request body.
- **Tables are one interface** (`MessageTables`); `test/tables.test.ts` is its conformance suite.
- **Never link or cite another private repo** in code, comments, tests, fixtures, docs, changesets, commits or PR text. Use `acme/web` in fixtures. This applies to Tigeryard if it is private: describe what it does, do not link it. (`TIGERYARD-PARITY.md` and `design/benchmarks.md` already name it.)
- **PR titles.** `<type>(<area>): <what it does>`, imperative, about 60 characters, one change per PR.
- **PR bodies.** One line, then the four answers (Users, Protocol / backends, Performance / I/O, Tests), then `### Users`, `### Protocol / backends`, `### Open` only. Transcripts pasted from real runs. One screen. Users is `none` exactly when there is no changeset. Use `.claude/skills/pr-description`.
- **Changesets.** A change people will notice gets one (`pnpm changeset`). Never edit `src/version.ts`. Publishing is disabled on the fork (#47).
- **Tests.** Every test written, changed or reviewed goes through `.claude/skills/test-behavior`: break what it claims to test and see it fail; pin no internals. Mocking board's own code does not count. Auth in tests is real `jose` verification with no bypass.
- **CI.** `pnpm check` (build, typecheck, test) is the required status.
- **Docs.** Plain GFM, relative links, A2's voice, "board" lowercase; a visible change updates its page; `test/docs-links.test.ts` and `test/docs-guide.test.ts` enforce parts of this.
- **CLI output.** One line per fact, lowercase, no emoji or color, columns, 80 columns, errors as data (`src/cli/failure.ts`), `--json` one document, exit codes 0, 1, 2, 130.
- **Inspector.** `app/board.ts` is the only data path; state is pure in `app/store.ts`; if the page needs something, add it to the handle, not the page. Proxy trust rules stay. Just Chat's UI invariants hold.
- **Swarm template.** Stays generic and standalone on the npm release; no names, teams, boards or URLs of ours.
- **Runtime guide.** `packages/runtime/README.md` is that package's guide; SPEC.md is the design and must be read before changing behavior.
- **From the user's global instructions.** Names say what the thing is in standard vocabulary; existing conventions win.

## 7. Gaps and unknowns

**Gaps (Politburo has no code for these today).**

1. No supervisor process. `packages/runtime` is a library. Nothing runs `watchRemote`, `reviewGate`, `stallWatcher`, `runController`, `refill` or a heartbeat on a schedule. There is no `vb` command or daemon that hosts them (frontend G9).
2. No launcher for any tier. Nothing starts a spawner, secretary, mob (cloud session) or sprite. `HarnessKind` has `claude-cloud` and `codex-cli` with no adapter. `pi()` shells out to `pi-task`, which is not in the repo.
3. No pi router setup. The three-tier fallback extension, `sprite-start`, and the `PI_*` environment handling are outside the repo. The runtime's `createRouter` is a different thing with no real executor.
4. No secretary tooling: no mailbox router, no digest, no `swarm-*@1` schema registration, no patch-apply-and-push path, no quick-check lock.
5. No swarm skills. `skills/` has only upstream `board` and `configure-factory-board`. The `mob-creation` skill visible in the session is not in this repo.
6. No serial counter, no species, item or secretary name allocation (only the spawner pool).
7. No lifecycle after `completed`: no scope gate, review or QA stages, evidence gates (held #20, #21, both conflicting with main).
8. Inspector swarm views: only queue and mobs exist, in a draft PR. No tree, inbox, PR gate or escalation view. Presidium shows one board.
9. `--swarm` cannot be combined with `--team-tokens`, so there is no documented remote multi-user swarm board without invites plus your own proxy, or Tailscale.
10. No per-agent credentials. Profiles are self-chosen labels under one principal. A registry entry's binding is a cooperative claim. Giving each mob its own principal means one invite per mob.
11. No message expiry, no mailbox-level schema enforcement, no positive CI label from sync (G2), no review head label (G1), no verdict severity (G3).
12. No cost reporting; no wake at usage reset; capacity slots do not expire.
13. Registry and inbox events never reach `/events`; a UI or loop must poll them.
14. `bench-run@1` has no collector.

**Unknowns (not verified in this pass).**

- Nothing was built or run. Test counts and "passes" come from PR text.
- Tigeryard's side was not read. Every statement about what Tigeryard provides comes from Politburo's docs.
- SPEC.md was skimmed by heading; sections on sync, watchers and the local board were not read in full. `src/server/tasks.ts`, `serve.ts` (1,398 lines) and `cli/main.ts` (3,590 lines) were not read line by line.
- Whether `PostBody.id` uniqueness is per board, per channel or per author.
- Whether a `vb serve` board accepts watcher registrations from a remote `http()` client in practice (the route exists; team-mode docs say it has "no sync or watchers of its own").
- Whether the Handoffs and Presidium pages came from fork PR #1 (not in the last 45 merged) or another PR; they are on main either way.
- PR #45, #44, #39 mergeability was `UNKNOWN` from `gh`; #20 and #21 are `CONFLICTING`.
- Whether Tigeryard is a private repo for the purpose of the "never cite" rule.
- The two design docs disagree on mail transport (operational inbox in `swarm-architecture.md` section 3 and `mob-retirement.md`; threads and labels in `swarm-secretaries.md` and `swarm-frontend.md`). All are `status: proposed`; the owner has not decided on the PRs.
