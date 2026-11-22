# Tigeryard into Politburo: merger plan

Author: merger coordinator (mail tag `mg`). Written 2026-11-22 about 07:30Z.
Status: **waiting for bonklek's OK.** Only the freeze (section 3) is in force.

Evidence base (read these for detail; this plan cites their row IDs):

- `merger/research/tigeryard-inventory.md`: 219 capability rows of Tigeryard at `origin/main` `19004c0` (IDs `UI-`, `BRD-`, `SUP-`, `SEC-`, `SPR-`, `SKL-`, `POL-`).
- `merger/research/politburo-inventory.md`: Politburo at `origin/main` `b146e75b` (IDs `PB-`).
- `merger/research/live-dependencies.md`: what the live swarm uses, as of 06:45Z (rows `L1` to `L29` below mean its dependency table rows 1 to 29).

Nothing was run for this plan. Every "works" claim below is a claim to be tested at its gate.

## 1. Summary

1. **Decision (bonklek, 2026-11-22):** Tigeryard becomes a layer inside the Politburo repo. Same UI, UX and intelligence. Rebuilt on Politburo's stack, not copied. Gradual. The live swarm never breaks.
2. **What the research changed.** Three facts shape the order:
   - The live swarm uses a small part of Tigeryard: file mail and the secretary wake loop, the mob-creation skill, the pi router and setup script v10, the check lock, the serial counter, and hand-rolled core scripts. About half of the supervisor and all of the Tigeryard issue board are **not** in the live loop.
   - Politburo already rebuilt much of the unused half as a tested library (`packages/runtime`), but **no process runs any of it**, and it has no mail, no secretary, no sprite tooling and no skills.
   - The live tooling is fragile today: secretaries run Tigeryard code from `/private/tmp` copies at different commits, and `core_mail.sh` exists only in core's scratchpad. A reboot removes both.
3. **Shape of the merger.** A new workspace package holds the swarm layer (processes, mail, sprite tools, skills). The board carries the records. The inspector carries the UI. Tigeryard stays the running system and the test oracle until each piece is cut over, one dependency at a time, each with a shadow run and a rollback.
4. **One owner per capability from today.** Politburo builds everything new. Tigeryard only keeps the live swarm running and supplies the reference behaviour. Details in section 3.
5. **Order of live cutovers:** documents and skill, then schemas, then mail (pb first, core last), then the sprite setup script, then watching and reporting, then the owner inbox, then the operator UI. Tigeryard's spawner retires after its last duty moves. Its repo goes read-only, then archived, last.

## 2. Target architecture: where the Tigeryard layer lives

| Layer | Path in Politburo | Holds | Rule |
| --- | --- | --- | --- |
| L1 Board core | `packages/board/src` (not `inspect`) | Records: threads, labels, blocks, tasks, attention, pause, registry. | Add as little as possible here. Fork thinness is a tracked hill. Swarm concepts stay conventions (channels `swarm/<tag>/...`, labels `swarm.*`, block schemas `swarm-*@1`). |
| L2 Inspector | `packages/board/src/inspect` | All operator UI. | The page reads only the board handle (`app/board.ts`). No swarm-only API. |
| L3 Runtime library | `packages/runtime` | Functions that talk to the board and to a harness: runner, review gate, watcher poll, usage guard, capacity, stall check, scoreboard. | Stays a library. No daemon here. |
| L4 Swarm layer (new) | `packages/swarm` (name is question Q1) | What Tigeryard is to the live swarm: mail (send, route, digest, expiry), the script-only secretary, check-and-push, retire check, check lock, serial, core watch, sprite tools (`pi-task`, `sprite-*`, pi router, setup-script build), skills, policies, and the long-running processes that host L3 functions. One CLI. | Uses the public board handle and L3 only. Nothing in `packages/board` imports it. Node standard library plus the workspace; no paid service. |
| L5 Parity suite | `packages/swarm/parity` | Golden cases: input and expected output recorded from Tigeryard's Python. | Written by the Tigeryard spawner. The Politburo code must pass them. This is how "same intelligence" is proven without copying code. |

Mail transport: thread roots in `swarm/<tag>/inbox` with a `swarm-message@1` JSON block and `swarm.class`, `swarm.urgency`, `swarm.state` labels, as `design/swarm-secretaries.md` and `design/swarm-frontend.md` already say. `design/swarm-architecture.md` says "operational inbox"; that line is wrong and is fixed in Phase 1. Mail moves **once**, from files to the board, behind a two-way file bridge, so tags can switch one at a time.

## 3. Immediate freeze (in force now; mailed as mg-0001 to `pb`, mg-0002 to `ty`)

Rule: until this plan's phases assign it, **nobody starts or continues work on a capability the other spawner also has or is building.** A frozen PR stays open and unmerged; its content becomes input to the Politburo design.

### 3.1 Ownership from today

| Area | Owner | The other side |
| --- | --- | --- |
| New swarm capability of any kind (code, schema, design) | Politburo | Tigeryard builds none. |
| Operator UI | Politburo (inspector) | No UI work in `board/server.py`. |
| Keeping the live swarm running (bug fixes to the running mail tooling, router, setup script, check lock, local CI, rollout notices) | Tigeryard | Politburo changes none of it. |
| `pi-task`, `sprite-*`, pi router, setup script | Tigeryard until cutover C7; **every change request goes through `mg`** (core-0111) | Politburo asks `mg`, not `ty`. |
| Mob-creation skill, naming, review and retirement policy text | Tigeryard until cutover C1; edits only to apply a ruling from bonklek or core | Politburo edits no `design/swarm-*.md` port. |
| Benchmarks (`bench-run@1`) | Politburo (core-0111) | Tigeryard supplies sprite log fields on request through `mg`. |
| Reference behaviour and parity cases | Tigeryard | Politburo consumes them. |

### 3.2 Tigeryard spawner stops today

| Item | Action |
| --- | --- |
| PRs 59, 60 (board_report, sprite_reporter, board_list), mob 172-BEE6 | Stop. No more sprite rounds. Leave open, unmerged. |
| PRs 51, 53 (centaur mode), mob 169-PANDA5, the centaur pilot (core-0068) | Stop. Leave open. |
| PRs 56, 57 (secretaryd notifier and cutover doc), mob 168-BEE5, the secretaryd cutover (core-0069) | Stop. **Cut no tag over to `secretaryd`.** The script-only secretary arrives once, from Politburo (Phase 3). See question Q7. |
| PR 50 (mob scripts), mob 145-BEE4 | Stop. Leave open. Moves to the sprite layer in Phase 4. |
| PRs 23, 20, 19 and issue 39 (legacy watcher, issue-list UI, startup policies) | No work. |
| Backlog: observability build mob, token-free mob runner, token broker, Maildir change, replay follow-ups, doc dedupe phase 2 (142-PANDA3), `pi-task` changes (bench.json, auto-retry, watchdog, sprite-watch cap) | Do not dispatch. `pi-task` items wait for Phase 4 unless they fix a p0 or p1 breakage. |

Tigeryard may continue: PR 58 (rollout tool) to a merge or a park under the normal review policy; 207-BEE7 (test leak fix that unblocks local CI); 221-PANDA (research bonklek asked for directly); rollout `ty-r002` acks; fixes for a p0 or p1 breakage of live tooling; answers to `mg`.

### 3.3 Politburo spawner stops today

| Item | Action |
| --- | --- |
| Secretary-mail pilot on a board (`swarm/pb/inbox`), owner asks as board decisions, swarm table, core heartbeats as messages | Do not dispatch. They become Phase 3 and Phase 5 steps under this plan's gates. |
| Status mirror `swarm-status@1` (G8), serial and check lock on the board (G12), router state (G15), digest module (G13), watcher loop (G9) | Do not dispatch. |
| PR 44 (swarm queue and mobs views) | Stays parked. |
| `packages/runtime`: `router/`, `remote/`, `usage.ts`, `capacity.ts`, `names.ts`, `stall.ts`, `controller/`, `ops/` | No changes except a fix for a failing check on `main`. |
| `design/swarm-architecture.md`, `swarm-secretaries.md`, `swarm-naming.md`, `mob-retirement.md` | No edits. |
| PRs 20, 21 (lifecycle stages, evidence gates) | Stay held. |
| Direct asks to Tigeryard about `pi-task` or sprite logs (pb-0010) | Send them to `mg`. |

Politburo may continue: 218-BEE7 benchmarks (collector, ingest; it reads the sprite logs as they are today), 220-BEE8 needs-action landing page, 214-GOLEM2 hot-file split, 215-PANDA3 follow-ups, PR 39, PR 45 as it stands, DST on the board write path, upstream sync, board integrity items.

### 3.4 Both

- No design negotiation between `pb` and `ty` on an overlapping capability. Send it to `mg`.
- Each spawner reads its inventory file and replies to `mg` with corrections (wrong rows, missing capabilities, live mobs not listed).

## 4. Capability matrix

One row per capability. "TY rows" are the inventory IDs the row covers. The mapping was made by hand and not machine-checked; step 0.2 asks the Tigeryard spawner to find any inventory row that no row here covers. "Live" says who in the running swarm uses it today. Verdicts: **Rebuild** (in Politburo, at the layer named), **Covered** (Politburo already does it; only a parity check is needed), **Drop** (with the reason; all drops need bonklek's OK, question Q4). The acceptance test is the parity check I will judge at the gate.

### 4.1 Live swarm capabilities (these have a cutover step)

| # | Capability | TY rows | Live today | Politburo today | Verdict, layer | Acceptance test | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M01 | Mob-creation skill and its sync to `~/.claude/skills/mob-creation` | SKL-02; L1, L1a | All six spawners | None in repo; core copies by hand | Rebuild, L4 `skills/mob-creation` plus a sync command | Sync command run twice gives a byte-identical installed file; installed file has no link to the Tigeryard repo; each of the six spawners starts one mob from it and the brief passes the skill's own checklist | 2 |
| M02 | Brief template and the five brief fields | SKL-12, SKL-13, SPR-09 | Spawners, mobs | None | Rebuild, L4 docs | A brief written from the new template is accepted unchanged by a mob that then reports in the required format (one mob per tag) | 2 |
| M03 | Policies as text: tiers and shares, naming (mobs, sprites, secretaries, spawners), class ceilings, review policy, merge guardrail, retirement, heartbeat, usage, launch, git, credential rule, report format, escalation order, urgency table | POL-01 to POL-19, POL-22, POL-23 | All tiers | `design/swarm-*.md` (ports that already disagree with Tigeryard and with the notes folder) | Rebuild, L4 docs: one set, generated into the skill; the notes-folder rulings are the source where they are newer | Diff of every rule against `N/review-policy.md`, `N/mob-and-sprite-naming.md`, `N/secretary-messaging.md`, `N/secretary-v2.md`: zero unexplained differences, signed off by core | 2 |
| M04 | Message header schema v1 and digest schema v1 | SEC-01, SEC-02; L2 | Every mail sender and secretary | Designed as `swarm-message@1`, `swarm-digest@1`; no code | Rebuild, L4 schemas registered on the board | All 28 Tigeryard header fixtures (`supervisor/fixtures/secretary/ex-0001` to `ex-0028`) give the same accept or reject result; every header in `N/mail/log.yaml` since 2026-11-21 validates the same way | 2 |
| M05 | Mail delivery: validate, id reservation, dedupe on `[from, ref, class]`, reject with reason and notice, atomic write, shared log | SEC-03, SEC-04, SEC-07, SEC-08, SEC-10, SEC-11; L3, L6 | All secretaries | Board has idempotent post, compare-and-set labels, schema-checked blocks; no mail code | Rebuild, L4 mail on board threads | Parity cases from Tigeryard for each rule (new, duplicate, older `at`, id collision, oversized, invalid) give the same outcome; a killed sender mid-write leaves no half message | 3 |
| M06 | Routing by header only: p0 now, p1 within 10 minutes, p2 and p3 into the digest, `sec.log` counted; digest every window | SEC-12, POL-07; L5, L8 | All secretaries | None | Rebuild, L4 | Shadow run: for 24 h the Politburo router, fed the same mail, produces the same `forward_now`, `forward_batch`, `act_on` and counts as the Tigeryard router for every window, for `pb` first | 3 |
| M07 | Expiry of p2 and p3 mail | SEC-09 | Secretaries | Gap (no message expiry) | Rebuild, L4 (reader-side `expires` in the block, state label `expired`) | Parity cases; an expired p2 never appears in a digest; a p0 with `expires` is rejected | 3 |
| M08 | Wake loop and the script-only secretary (no model session in the loop) | SEC-14, SEC-15, POL-14; L4, L7 | 7 wake loops (3 seen running); `secretaryd` merged but unused | `GET /events` long-poll, `vb wait`; no daemon | Rebuild, L4 `secretary` process under launchd | A p0 mail wakes the spawner within 60 s and a p1 within 10 minutes with the loop running under launchd and **no** model session routing; the loop survives a reboot; 48 h with zero missed or duplicate forwards on `pb` | 3 |
| M09 | Owner-decision mail: `needs: owner`, default if unanswered, review-by reminders, owner queue | SEC-05, SEC-06, SEC-13; live `mail/bonklek`, `mail/owner` | Core, bonklek (three unconnected inboxes today) | Structured attention (`vb tasks ask/answer`), Attention view, `--responder`, decisions tool (PR 45) | Rebuild as one inbox, L4 on L1 attention, L2 view | Every open item in `mail/bonklek`, `mail/owner` and the port-4170 board appears once in one view; an answer is applied once, a stale answer is refused; an unanswered item applies its default at `review_by`; bonklek confirms he can answer from one place | 5 |
| M10 | Check-and-push of a mob patch | SEC-16; L9 | RDN (Peggy), others rarely | None | Rebuild, L4 | Parity cases on a scratch repo: clean patch pushes only the verified commit; failing check pushes nothing and restores the branch; lock always released (the PR 48 cases) | 5 |
| M11 | Swarm-wide check lock with owner record and safe stale-break | SEC-17; L11 | Olive (held now), `sec_push` | Heavy slots as lock directories in `capacity.ts` | Rebuild, L4; stays a **file** lock in `N` (advisor R2) | Two processes contend: one runs, one waits; a lock whose holder is provably dead is broken with a log line; a live holder is never broken; the Tigeryard tool and the Politburo tool exclude each other during the overlap | 5 |
| M12 | Retire check (all branch heads on origin, worktree clean) | SEC-18, POL-11; L10 | Spawners by hand | `vb agents retire` records only | Rebuild, L4 | Parity cases: unpushed commit gives "not safe"; all pushed gives "safe"; verdict mailed | 5 |
| M13 | Mob serial counter and name pickers | SEC-23, SEC-24, POL-02, POL-04 to POL-06; L12, L13 | Every spawner (shell one-liner on `N/mob-serial.txt`) | Spawner name pool only | Rebuild, L4; the counter file stays where it is | 100 concurrent allocations give 100 distinct serials continuing from the live value; the old one-liner and the new command interleave safely | 3 |
| M14 | Liveness files and the stall, slowdown and stuck-secretary watch; PR log | SEC-21, SEC-22; L17, L20, L27 (`core-watch.sh`, `prs.log`, `caffeinate`) | Core through Hildy | `stallWatcher` function, no loop | Rebuild, L4 `watch` process | Shadow run 24 h beside `core-watch.sh`: same alerts (stall, under 4 PRs per hour, stuck tag), same `prs.log` lines; kill a wake loop and the alert arrives within its window | 5 |
| M15 | Core's mail sender | L18 (`core_mail.sh`), L19 (Hildy) | Core | `vb post --schema` | Rebuild, L4 `mail send` | Core sends to one tag and to all tags; each arrives once with the right header; the tool lives in the repo, not in `/private/tmp` | 3 |
| M16 | Swarm config and policy notices | SEC-25, SEC-26 | Nobody yet (merged, not deployed) | Proposed `swarm-repo@1` | Rebuild, L4 (one config record on the board) | A bump delivers one p2 policy notice per mailbox, once per version | 5 |
| M17 | Rollout of a change to the live swarm (entries, notices, acks, stale ledger) | SEC-28, POL-12; L26 | Tigeryard spawner by mail; tool is PR 58 | None | Rebuild, L4 | A test rollout reaches all tags; the ledger shows who has not acknowledged; used for every cutover in this plan from Phase 3 on | 3 |
| M18 | Local CI on an exact head with a commit status | SEC-27; L22 | Olive (hand scripts), the merge gate for every Tigeryard PR | `pnpm check` by the mob; no hosted evidence | Rebuild, L4 `ci run` | A PR head gets a `local-ci/mac` status that names that exact SHA; a new push invalidates it; runs under the check lock | 5 |
| M19 | Exception digest (revision-aware) | SEC-19, SEC-20 | Nobody yet | None | Rebuild, L4, after M06 | Tigeryard's replay fixture gives the same duplicate-notice rate | 5 |
| M20 | pi router `fallback/codex-cursor`: three tiers, persisted cooldown, same-request failover, stream-idle failover, env overrides | SPR-01 to SPR-04; L14 | Every sprite | `createRouter` is a different thing with in-memory cooldowns | Rebuild in L4 `sprite/router` (it is already TypeScript; question Q2 asks to move it as-is with its tests) | Its existing test file passes in Politburo CI; in a canary VM a forced quota error on tier 1 fails over inside the same request and the cooldown survives a new process | 4 |
| M21 | `pi-task`, `sprite-start`, `sprite-watch`, `sprite-stop`, `pi-auth-ensure` | SPR-05, SPR-06, SPR-10, SPR-11; L15 | Every mob | `pi()` adapter calls `pi-task`; no source | Rebuild, L4 `sprite/` as real files with tests (today they exist only inside the pasted script) | Each exit code matches (124 runtime limit, 125 idle, sprite-watch 0, 1, 3, 10); idle stop at 180 s; task passed as a file; bench fields written at exit (M24) | 4 |
| M22 | Cloud setup script | SPR-07; L15 | Every cloud VM, pasted by bonklek | None | Rebuild, L4: generated from repo sources by one build command | Built script installs the same versions as v10 (pi 1.4.0, Cursor provider 0.5.1 plus patch) and passes a canary mob run: one sprite completes, one forced failover works; the md5 is recorded; v10 kept for rollback | 4 |
| M23 | Mob scripts (`setup_mob`, `prove_failure_on_base`, `run_long`) | SPR-12 (PR 50, frozen) | Nobody yet | None | Rebuild, L4 `sprite/`, shipped by the setup script | A mob uses each once and reports; `prove_failure_on_base` fails on base and passes on the fix for a known case | 4 |
| M24 | Sprite telemetry for benchmarks | core-0111, pb-0010 | Asked by Politburo | `bench-run@1` design (PR 64) | Rebuild, L4 `sprite/` (emit) and L3 or tools (ingest) | One sprite run yields one `bench-run@1` record with model, thinking, times, tokens, diff numstat, attempt number and exit reason | 4 |
| M25 | Mob and sprite status reporting to a board | PRs 59, 60 (frozen); L16 | Nobody (no board is in the loop) | Design G8; PR 44 views | Rebuild, L4 reporter and mirror, L2 views. Transport is question Q3 | For one live mob per tag the board shows its state, branch, last report and sprites within one heartbeat; a dead mob shows as stale, never as working | 5 |
| M26 | Brief storage on `ty-brief/<id>` branches | L23a | TY and PB spawners | None (a Git convention) | Covered as a convention; documented in M02. Rename to `brief/<id>` only at wind-down | A mob fetches its brief from the documented branch in each repo | 2, 7 |
| M27 | Privacy preflight before commit and push | POL-20; L29 | Tigeryard mobs | `ops/privacy.ts` `scanDiff`, `preflight` | Covered; parity check only, then wire a command in L4 | Tigeryard's clean and dirty samples give the same pass or fail | 5 |
| M28 | Keep-awake for the Mac | L27 | Whole swarm | None | Rebuild inside M14's process | `caffeinate` is restarted within one cycle after being killed | 5 |

### 4.2 Control-plane intelligence (not in the live loop today; parity is still required)

| # | Capability | TY rows | Live today | Politburo today | Verdict, layer | Acceptance test | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M30 | Remote work over git refs: publish brief and control, register, reply, pause, resume, cancel, reassign | SUP-01 to SUP-03, SUP-10 | Nobody (no `ty/*` refs exist) | `localGit` on `remote/<agent>/{brief,control,inbox,status}` (PB-49) | Covered for exchange; Rebuild the spawner commands in L4 | Parity cases for each command; cancel is one atomic write; a generation never goes down | 6 |
| M31 | Status validation and trust rules (session, brief, attempt echo; ordering; generation) | SUP-09, SUP-11 | Nobody | Partial in `watcher.ts` | Rebuild, L3 | Tigeryard's `test_protocol_v2` cases as parity cases: same accept or reject | 6 |
| M32 | Watcher loop: poll, project status to the board, stale detection, draft PR, check on the exact head, backoff, status table, rebuild, cleanup with archive tags | SUP-08, SUP-12 to SUP-15, SUP-17 to SUP-20 | Nobody | `watchRemote().poll`, `ghCodeHost` (PB-50); no loop | Rebuild, L4 process hosting L3 | Tigeryard's replay fault cases (`supervisor/replay`) re-expressed as a seeded test: same phase for each task at the end; the pause race (seeds 13, 66, 215, 257) does not reproduce | 6 |
| M33 | Review gate: reviewer session, HMAC-signed verdict, ready only with green check and clean verdict on the same head; never merges | SUP-16, SUP-23, SUP-24 | Nobody (spawners gate by hand) | `reviewGate`, `signVerdict` (PB-51); no severity, no reviewer launcher | Covered in part; Rebuild severity and the reviewer start, L3 and L4 | Verdict vectors signed by Tigeryard verify in Politburo and the reverse; a `clean` verdict with a `high` finding is refused; a new push returns the PR to draft | 6 |
| M34 | Harness interface and adapters (local subprocess, Claude cloud, pi, Codex CLI) | SUP-04 to SUP-06, SUP-45, SUP-46, SUP-48, SUP-50 | Spawners launch cloud mobs by hand | `Harness`, `fake`, `subprocess`, `pi` (PB-42); `claude-cloud`, `codex-cli` are names only | Covered for the interface; Rebuild `claude-cloud` and `codex-cli` adapters, L3 | The shared conformance suite passes for each new adapter; `claude-cloud` `start` returns the operator prompt and `send`/`cancel` work on a bound session | 6 |
| M35 | Check runner with allowlisted env, safe group kill, machine-wide heavy slots | SUP-21, SUP-22 | Nobody directly | `subprocess`, `capacity` heavy slots (PB-45) | Covered; parity check | Signal-safety cases: a reused pid is never signalled | 6 |
| M36 | Usage guard tick and wake at reset | SUP-25, SUP-26, POL-15; L21 | Nobody (rule is "run to 100%") | `usageGuard` at 95%, no wake (PB-44) | Rebuild threshold from config (default 100) and the wake, L3 and L4 | At `stop_percent` no dispatch; one wake fires one minute after `resets_at`; unknown usage does not block | 6 |
| M37 | Issue refill (three researchers, critic, up to 15 issues) | SUP-27 | Nobody | `refill` (PB-52); caller supplies the agent | Covered for the write; Rebuild the researcher and critic prompts, L4 | A dry run on a seeded board proposes at most 15 tasks, all held for approval, none duplicating an open task | 6 |
| M38 | Resume packets and attempt ledger | SUP-29, SUP-38, SUP-40, SUP-41 | Nobody | `ops/packets.ts` (PB-53) | Covered; parity check | A packet written for a claimed task reads back identically | 6 |
| M39 | Routed attempts: task contract, route selection, cooldowns, daily limits; routing modes | SUP-33, SUP-34 | Nobody | `createRouter` (PB-48), in-memory cooldowns | Covered in part; Rebuild persisted cooldowns and modes, L3 | Cooldown survives a restart; parity cases for failure classes | 6 |
| M40 | Model scoreboard | SUP-37, UI-09, UI-10 | Nobody | `boardScoreboard` (PB-48); `bench-run@1` design | Rebuild on benchmark records, L3 and L2 | Scoreboard view ranks routes from real `bench-run@1` records with numerators and denominators | 6 |
| M41 | Provider access incidents and recovery | SUP-35, SUP-36, UI-11, UI-12 | Nobody | One auth probe in the router | Rebuild, L3 and L2 | A login failure blocks that account, records one incident, and shows the recovery command; no raw provider error is shown | 6 |
| M42 | Usage and cost normalisation | SUP-39 | Nobody | Gap (no cost reporting) | Rebuild inside M24 | Token counts from a pi run normalise to one record with provenance | 4 |
| M43 | Controller sessions that wake on mail and escalate | SUP-42 | Nobody | `runController` (PB-47), operational inbox only | Covered; Rebuild a thread-mail variant in L4 | An unacknowledged p1 escalates to the parent at its deadline | 6 |
| M44 | External-action journal | SUP-49 | Nobody | None | Rebuild, L3 (small) | A crash between "prepared" and "confirmed" is reported as ambiguous, never resent blindly | 6 |
| M45 | Seeded replay of the control plane | SUP-44 | Development tool | DST harness on the board (PB-36) | Covered by extension: replay targets the Politburo watcher | See M32 | 6 |
| M46 | Startup instructions, role profiles, the eight roles, harness registrations, templates | SUP-28, SKL-01, SKL-03 to SKL-11, SKL-14 to SKL-19, BRD-07, BRD-19, BRD-20 | Spawner skill only; role skills unused | Agent registry with eight roles (PB-29) | Rebuild the spawner, mob, research and reviewer skills in L4; role profiles Covered by the registry | Each rebuilt skill used once by its tier in a live run | 2, 6 |

### 4.3 Board data and rules

| # | Capability | TY rows | Politburo today | Verdict, layer | Acceptance test | Phase |
| --- | --- | --- | --- | --- | --- | --- |
| M50 | Issues with a 16-state lifecycle, scope before work, review and QA stages | BRD-02, BRD-21, BRD-22, BRD-25 | 7 task states; stages held in PR 21 | Rebuild, L1 (new design; PR 21 is not revived as is) | Parity cases for each allowed and refused transition | 6 |
| M51 | Evidence gates bound to a commit; override audited | BRD-26, BRD-25 | Held in PR 20 on security findings | Rebuild, L1 (new design) | A stage move without `submission` and `tests` evidence on the current head is refused; an override records who and why | 6 |
| M52 | Dependencies with evidence-released edges, cycle refusal | BRD-03, BRD-23 | `needs`, released on complete (PB-04) | Covered in part; Rebuild evidence release with M51 | A cycle is refused; a dependent stays waiting until the edge is resolved | 6 |
| M53 | Claim with lease, binding and generation fence | BRD-24 | PB-02, PB-05 | Covered | Conformance group `tasks` | 6 |
| M54 | Five-level priority; agents may lower, not raise | BRD-45, BRD-15, UI-19 | PB-03 | Covered | Parity cases | 6 |
| M55 | Network pause as a generation change | BRD-17, BRD-16 | PB-11 (starts running unless `initiallyPaused`) | Covered; set the swarm board to start paused | A paused board refuses claims; old grants give nothing after resume | 6 |
| M56 | Operator block and restore | BRD-46 | Park and unpark (PB-10) | Covered | Parity cases | 6 |
| M57 | Human attention: machine-checked decision form, versioned request, one-shot response that routes the next step, drafts, reconcile | BRD-33 to BRD-35, UI-20, UI-21, SKL-15 | PB-09, PB-33; no drafts, no evidence list, no routed next state | Covered in part; Rebuild the missing parts, L1 and L2 | Tigeryard's attention cases: an agent-actionable reason is refused; an expired or superseded response changes nothing | 5 |
| M58 | Durable messages with receipts, redelivery until acted, supersession, archive, 15-message reads | BRD-04, BRD-05, BRD-28 to BRD-32 | Operational inbox (PB-32) | Covered | Redelivery cases: `seen` does not consume, `acted` does | 6 |
| M59 | Agent registry, observations, health labels from fresh receipts, command intents | BRD-08, BRD-09, BRD-40 to BRD-42, UI-16, UI-17 | PB-29 to PB-31 | Covered | "Working" shows only with a fresh receipt | 6 |
| M60 | Append-only history with role-aware attribution; integration facts | BRD-11, BRD-43, BRD-44 | One append-only log; no per-task history route | Rebuild the history read, L1 and L2 | A task's history pages by 50 with filters; no event can be edited | 6 |
| M61 | Blocker explanation ("why isn't this running") | BRD-47, UI-04 | `grants explain` only | Rebuild, L1 read and L2 panel | For a seeded task the panel lists every blocker (pause, dependency, hold, park, lease) | 6 |
| M62 | Convergence check and goal | BRD-14, BRD-36, BRD-37, UI-13, UI-14 | None | Rebuild, L3 and L2 (read-only) | On a seeded board the check says "not converged" with reasons, and "converged" only when every task is done with gates passed | 6 |
| M63 | Project identity and share links | BRD-18, UI-27 | Named boards | Covered | Board name shows in the header | 6 |
| M64 | Scaffold a new instance; schema guard; migration | BRD-50, BRD-51, BRD-16 | `createInstance` (PB-55) | Covered | A scaffolded instance serves with no credentials | 6 |

### 4.4 Operator UI (the "same UI and UX" part; all in L2, the inspector)

| # | Screen or behaviour | TY rows | Politburo today | Verdict | Acceptance test | Phase |
| --- | --- | --- | --- | --- | --- | --- |
| M70 | Board home: eight columns, counts, search, lane and priority filters, focus one column, column menus | UI-01, UI-26 | Handoffs lanes, flat Tasks list | Rebuild | Side by side on the same seeded data: same eight columns and the same card in each | 6 |
| M71 | Issue detail: scope, blocker, 15 current messages, responsibility, handoff, gates, status label, why-blocked, priority form, attention response, paged history | UI-03, UI-19 to UI-21 | Task page with holds, priority, attention answer | Rebuild the missing panels | Checklist of the eleven panels on one seeded task | 6 |
| M72 | Agent health page and per-agent inbox and harness views | UI-02, UI-05, UI-06 | Registry exists; the inspector does not read it | Rebuild | Stale agents are badged stale; grouping by hierarchy and by ownership | 6 |
| M73 | Review queue | UI-07, UI-08, UI-18 | None | Rebuild on PR records (`swarm-pr@1`), not on the removed scheduler's tables | A PR ready for review appears once and moves to "reviewed" when marked | 6 |
| M74 | Scoreboard and provider access pages | UI-09 to UI-12 | None | Rebuild (with M40, M41) | See M40, M41 | 6 |
| M75 | Convergence page | UI-13, UI-14 | None | Rebuild (with M62) | See M62 | 6 |
| M76 | Create issue, poke, command intents from the page | UI-15 to UI-17 | Create task from a thread; intents by CLI only | Rebuild the two forms | A poke supersedes the earlier one; a command expires | 6 |
| M77 | Live update that never moves what you read or clobbers a draft | UI-22 | Event stream; same invariant in AGENTS.md | Covered (stronger: stream, not a 15 s poll) | Type in a form during an update: the draft stays | 6 |
| M78 | Light and dark theme, density, keyboard shortcuts, help dialog, error pages | UI-23 to UI-25, UI-28, UI-30 | Theme and some keys | Rebuild density and the `g` shortcuts | Shortcut list parity; contrast checks pass in both themes | 6 |
| M79 | Loopback-only bind, CSRF, private link policy | UI-29, UI-31 | Proxy trust rules in AGENTS.md | Covered | Existing inspector trust tests | 6 |
| M80 | Swarm views that Tigeryard never had but the merged product needs: needs-you home, swarm tree, mail and digests per tag, PR gate, escalations, health and spend, pause and model controls | design G1 to G15; advisor UX notes | Attention view, pause control; queue and mobs in draft PR 44 | Rebuild (new, Politburo-owned already) | bonklek's four questions answered on one screen: what needs me, what to review, what is running, health and spend | 5 |

### 4.5 Proposed drops (need bonklek's OK, question Q4)

| # | Capability | TY rows | Reason |
| --- | --- | --- | --- |
| D1 | QA broker and `qa_runs` | SUP-43, BRD-10 | No entry point reaches it. Tigeryard's own parity note lists it as removed. |
| D2 | Adapter wrapper harness | SUP-07 | Imported only by its test. |
| D3 | Context packets and source lifecycle | SUP-30, SUP-31 | Synthetic fixtures only; no connector exists. |
| D4 | Pre-implementation audit | SUP-32 | No CLI, not imported by any entry point. |
| D5 | Handoff delta validation | BRD-49 | Imported only by its test. Immutable handoffs (PB-06) cover the live need. |
| D6 | Devin CLI adapter | SUP-47 | No Devin in the swarm. (RemiNET's own Devin health sync is separate; see Q5.) |
| D7 | `generic-cli` harness descriptor, status schema v1, role aliases for old names | part of SKL-11, SUP-09, BRD-20 | Legacy formats with no writer. |
| D8 | Removed fleet scheduler's tables and notifier (`execution_attempts`, `pipeline_stages`, `notification_attempts`, `review_marks` as built) | BRD-06, BRD-12, BRD-13 | Nothing writes them. The review queue is rebuilt on PR records (M73). |
| D9 | Convergence action routing and role loop boundaries | BRD-38, BRD-39 | No user. The convergence check itself is kept (M62). |
| D10 | Operational-outcome manifests (non-code outcomes) | BRD-27 | No user; about 30 refusal codes of surface. Revisit if a non-code workflow appears. |
| D11 | Local instance setup for pi CLI agents, `provider_pool` preparation, historical reconciliation import | SPR-08, SUP-36 (setup part), SUP-41 | Serve the old local-CLI model only. |
| D12 | Test-only display aids, ContextMink config, module inventory and startup-budget scripts | UI-32, POL-24 to POL-26 | Tooling for the Tigeryard repo itself. Politburo has `tools/metrics`. |
| D13 | launchd templates for the Tigeryard board and watcher; Tigeryard CI config; contracts index for the old receipts | UI-33, SUP-20, POL-21, BRD-48 | Replaced by Politburo's own service files, `pnpm check`, and board schemas. |
| D14 | Old board tables as storage (`board_meta`, `issues`, ...) | BRD-01 | Storage is not copied; the board's log replaces it. Data migration is question Q5. |

## 5. Phases

Who does what: **PB** = Politburo spawner (builds, through its mobs). **TY** = Tigeryard spawner (reference behaviour, parity cases, live upkeep). **core** and **bonklek** where only they can act. Every instruction goes through the secretaries. Each phase ends with a mail to `mg`; I answer PROCEED or HOLD with the exact gaps. Review policy and merge guardrail apply to every PR.

### Phase 0. Freeze and safety net (now)

| Step | Who | What |
| --- | --- | --- |
| 0.1 | mg | Dispatch the freeze (section 3). Done with this plan. |
| 0.2 | TY, PB | Reply with corrections to their inventory file. |
| 0.3 | core | Copy `core_mail.sh` out of the scratchpad into the notes folder; note which commit each secretary's tooling copy runs. (Recommended in the p1 to core; it is core's tool.) |

Gate G0: both spawners acknowledge the freeze; no new commit on a frozen PR after the acknowledgement (I check with `gh pr view`). Rollback: none needed.

### Phase 1. Foundations in Politburo (no live change)

| Step | Who | What |
| --- | --- | --- |
| 1.1 | PB | Design PR: the swarm layer package (section 2), its CLI command list, the mail transport on threads, and the fix to `design/swarm-architecture.md`. Mark `TIGERYARD-PARITY.md` as replaced by this matrix. |
| 1.2 | PB | Package skeleton `packages/swarm` with `pnpm check` wired, and registration of `swarm-message@1` and `swarm-digest@1`. |
| 1.3 | TY | Parity cases, as PRs to Politburo that touch only `packages/swarm/parity/**`: inputs and expected outputs recorded by running Tigeryard's code, for M04, M05, M06, M07, M10, M11, M12, M13 first. Format: one JSON file per case. No Tigeryard code is copied. |
| 1.4 | PB | A parity runner: one command that runs every case against the Politburo implementation and prints pass, fail or "not built" per matrix row. |
| 1.5 | PB | The swarm board: one `vb serve --swarm` board under launchd on the Mac, its own directory, started paused, with a stop-and-copy backup command. Channels `swarm/<tag>/inbox` for the eleven mailboxes. Only local sessions use it in this phase. |
| 1.6 | TY | Confirm, per tag, which commit of the secretary tooling runs, and bring every loop to `origin/main` (live upkeep; needed so the oracle is one version). |

Parity checks: `pnpm check` green on `main`; parity runner lists every Phase 2 and 3 row; the swarm board survives a restart with its data; backup restores to a second directory.
Gate G1: all of the above, and bonklek has answered Q1 and Q3. Rollback: revert the PRs; nothing live depends on them.

### Phase 2. Documents, skill and schemas (cutovers C1, C2)

| Step | Who | What |
| --- | --- | --- |
| 2.1 | PB | M03: one policy doc set under the swarm layer. M02: brief template. M01 and M46: `mob-creation`, spawner, mob, research and reviewer skills, with a sync command that installs into `~/.claude/skills/`. |
| 2.2 | TY | Review the PB text against Tigeryard `main` and the notes-folder rulings; list differences to `mg`. |
| 2.3 | core | **C1:** install the skill from Politburo with the sync command. Keep the old file as `SKILL.md.tigeryard`. |
| 2.4 | PB, TY | **C2:** Politburo's schema is the source. Tigeryard's JSON schema file becomes a generated copy; TY merges only that copy. |
| 2.5 | TY | Rollout notice to all tags: the skill and policies now come from Politburo. From here Tigeryard's `docs/swarm-*.md` and the skill source are frozen with a pointer. |

Parity checks: M01, M02, M03, M04, M26 acceptance tests.
Gate G2: all pass; every tag has acknowledged the rollout. Rollback: copy `SKILL.md.tigeryard` back; restore Tigeryard's schema file from Git.

### Phase 3. Mail and secretaries (cutovers C3 to C6)

| Step | Who | What |
| --- | --- | --- |
| 3.1 | PB | Build M05, M06, M07, M13, M15, M17 in the swarm layer, passing the parity cases. |
| 3.2 | PB | Build the file bridge: a token-free process that mirrors `N/mail/<tag>/` and the board both ways, so a tag on the board and a tag on files can still mail each other. Build M08, the script-only secretary. |
| 3.3 | PB, mg | **Shadow.** Mirror all file mail to the board read-only. Run the Politburo router on the board copy of `pb` for 24 h. Compare every digest and forward with the Tigeryard router's. I read the diff. |
| 3.4 | PB, Joan | **C3: `pb` goes live** on the Politburo secretary. Files stay written by the bridge. Soak 48 h. |
| 3.5 | TY, Olive | **C4: `ty`.** Soak 24 h. |
| 3.6 | PB with each secretary | **C5: `rw`, `rml`, `kg`, `rdn`** (and `peggy`), one at a time, at least 12 h apart. The rollout tool (M17) tracks each. |
| 3.7 | core, Hildy | **C6: `core`** mailbox and core's sender (M15), last. Then decide per tag whether the Haiku secretary session is retired (script-only) or kept for `sec.*` work; core proposes, bonklek decides (Q7). |

Parity checks: M05 to M08, M13, M15, M17. Shadow diff is zero for 24 h before each tag. After each cutover: no missed p0 or p1 (I sample the log), `core-watch` shows no stuck tag.
Gate G3 (per tag, then overall): the soak passed with zero missed or duplicate forwards and the rollback was rehearsed once on `pb`. Rollback (per tag, under 5 minutes): stop the Politburo secretary for that tag, start `secretary_wake` on the files (still current through the bridge), mail core.

### Phase 4. Sprite layer (cutover C7). May be built in parallel with Phase 3; its cutover waits for G2.

| Step | Who | What |
| --- | --- | --- |
| 4.1 | TY | Extract the exact text of `pi-task`, `sprite-start`, `sprite-watch`, `sprite-stop`, `pi-auth-ensure` and the settings step from setup script v10 into a behaviour note with every exit code and env name (no values), plus parity cases. |
| 4.2 | PB | M20, M21, M23: sources and tests under the swarm layer. M22: one command builds the setup script from them. M24, M42: telemetry at sprite exit. |
| 4.3 | PB | Build "v11": same behaviour as v10, built from Politburo. Telemetry is a separate "v12" so v11 can be compared one to one. |
| 4.4 | bonklek | Create a second cloud environment as a canary (Q6) and paste v11 there. |
| 4.5 | PB | Canary run: one mob, three sprites, one forced failover, one idle stop. Report. |
| 4.6 | bonklek | **C7:** paste v11 into `remidarknet`. Later v12 the same way (or the pinned stub, Q6). |
| 4.7 | TY | Rollout notice; mark Tigeryard `tools/pi-router` frozen with a pointer. |

Parity checks: M20 to M24.
Gate G4: canary report clean; the first three production mobs after the paste complete normally. Rollback: bonklek pastes v10 back (`N/pi-router/cloud-setup-script-v10.sh`, md5 `85ae4a3c…`); running VMs are unaffected either way.

### Phase 5. Watching, reporting, owner inbox, push and CI (cutovers C8 to C11)

| Step | Who | What |
| --- | --- | --- |
| 5.1 | PB | M14, M28: the watch process. Shadow 24 h beside `core-watch.sh`. **C8:** core switches; `core-watch.sh` kept for rollback. |
| 5.2 | PB | M09, M57: one owner inbox on the board. Import the open items from `mail/bonklek`, `mail/owner` and the port-4170 board. **C9:** core files new asks only there. |
| 5.3 | PB | M10, M11, M12, M18, M27: check-and-push, lock, retire check, local CI status. **C10:** Olive and Peggy switch, one after the other. |
| 5.4 | PB | M25 and M80: mob and sprite reporting and the swarm views, by the transport bonklek chose in Q3. **C11:** one tag (`pb`) reports first, then the rest. |
| 5.5 | PB | M16, M19. |

Parity checks: the acceptance tests of each row; for M14 the alert list of the shadow run matches.
Gate G5: every live dependency row `L1` to `L29` now points at Politburo or at a notes-folder file that Politburo's tools own; bonklek confirms the owner inbox works for him. Rollback: per step, restart the kept Tigeryard or shell tool (each is kept until Phase 7).

### Phase 6. Operator UI and control-plane parity

| Step | Who | What |
| --- | --- | --- |
| 6.1 | TY | Parity cases for M31 to M33, M36, M39, M50 to M52, M54, M56 to M58, and a seeded Tigeryard board plus screenshots of every screen (UI-01 to UI-14) as the UI reference. |
| 6.2 | PB | New designs for M50, M51 (replacing held PRs 20, 21), then build. |
| 6.3 | PB | L3 and L4: M30 to M45 gaps (adapters, loop, wake, persisted cooldowns, journal, scoreboard on benchmark records). |
| 6.4 | PB | L2: M70 to M78. |
| 6.5 | mg | Walk every matrix row: pass, or dropped with bonklek's OK. |

Gate G6: the parity runner shows no "fail" and no "not built" row; I have compared each screen against the reference; drops are approved. Rollback: not a live change.

### Phase 7. Wind-down of the Tigeryard spawner and repo (last)

| Step | Who | What | Needs |
| --- | --- | --- | --- |
| 7.1 | TY | Close or hand over every open Tigeryard PR: each is merged (upkeep), or closed with a comment naming the matrix row that replaced it. | mg PROCEED |
| 7.2 | TY | Retire every Tigeryard mob by the retirement rule. Move backlog items that survive into Politburo's backlog through `mg`. | mg PROCEED |
| 7.3 | core | Remove `ty` from core's dispatch list and from the watch. Olive stops. The Tigeryard spawner session is retired. | mg PROCEED and bonklek's OK through core |
| 7.4 | TY's last act, or PB | Tigeryard `README` says where everything went. Repo goes **read-only**: no merges, branch protection on `main`. | mg PROCEED |
| 7.5 | mg | 14 days of watching: no process on the Mac or in a VM reads the Tigeryard repo or a copy (check process list, the setup script, the installed skill links, launchd labels). | time |
| 7.6 | bonklek | **Archive** `bonklek/tigeryard` on GitHub. Rename `ty-brief/*` to `brief/*` in the other repos. | bonklek's OK through core |

Gate G7: G5 and G6 passed; question Q5 (the Remilytics and decomp boards, RemiNET's health sync) is settled; 14 clean days. Rollback: un-archive; the repo is intact.

## 6. Cutover order for live dependencies (one at a time)

| # | Dependency | From | To | Phase | Check before the next one |
| --- | --- | --- | --- | --- | --- |
| C1 | Mob-creation skill and policy text | Tigeryard `main`, hand copy | Politburo, sync command | 2 | M01, M03 |
| C2 | Header and digest schema | Tigeryard JSON | Politburo `swarm-message@1`; Tigeryard keeps a generated copy | 2 | M04 |
| C3 | `pb` mailbox and secretary | `secretary_wake` on files | Politburo secretary on the board, bridge to files | 3 | 48 h soak |
| C4 | `ty` mailbox | same | same | 3 | 24 h soak |
| C5 | `rw`, `rml`, `kg`, `rdn`, `peggy` mailboxes | same | same | 3 | 12 h each |
| C6 | `core` mailbox, `core_mail.sh`, Hildy's loop | scratchpad script, wake loop | Politburo mail commands | 3 | core sends and receives for 24 h |
| C7 | Setup script, pi router, `pi-task`, `sprite-*` | paste of v10 | paste of Politburo-built v11 | 4 | canary, then three production mobs |
| C8 | `core-watch.sh`, `prs.log`, keep-awake | notes-folder shell script | Politburo watch process | 5 | 24 h shadow match |
| C9 | Owner inbox | `mail/bonklek`, `mail/owner`, port 4170 | one board inbox | 5 | bonklek confirms |
| C10 | Check lock, check-and-push, retire check, local CI | Tigeryard tools and hand scripts | Politburo commands | 5 | M10, M11, M12, M18 |
| C11 | Board where mobs and sprites report | none today (session messages, PRs) | the swarm board | 5 | M25 |
| C12 | Brief branches `ty-brief/*` | convention | `brief/*` | 7 | each spawner confirms |

The header schema and mailbox files keep their current shape until C6 is done, so any tag can fall back.

## 7. Risks

| Risk | Guard |
| --- | --- |
| The board becomes a single point of failure for all mail (one process, one SQLite file). | The bridge keeps the files current until Phase 7. A dead board triggers the per-tag rollback. Backup command from Phase 1. |
| Live tooling runs from `/private/tmp` and can vanish on a reboot before Phase 3. | Step 0.3 and step 1.6. |
| The Politburo spawner now carries nearly all building work. | TY carries all parity cases and reviews; Phase 4 can run in parallel with Phase 3; question Q8. |
| `packages/board/src` grows (fork thinness hill). | Only M50, M51, M57, M60, M61 touch L1; everything else is L2 to L4. |
| Held PRs 20 and 21 have open security findings. | Not revived. New designs in step 6.2. |
| Two setup-script pastes confuse which version runs. | md5 recorded in each rollout notice; canary first. |

## 8. Open questions for bonklek

| # | Question | My recommendation |
| --- | --- | --- |
| Q1 | Name and home of the layer. | A new package `packages/swarm`. The name "Tigeryard" stays as the product name of the layer in docs if you want it. |
| Q2 | "Not copying code": the pi router extension is already TypeScript and live-proven. Move it and the five shell helpers as they are, with tests, or rewrite? | Move as they are. Rewriting them risks every sprite for no gain. Everything else is rebuilt. |
| Q3 | How do cloud mobs report to the board? (a) They do not reach it; a local mirror posts for them from Git refs and PRs. (b) Tailscale in the VM. (c) A TLS proxy in front of the board. | (a) first. It needs no new network path and matches today's rule that cloud mobs cannot message local sessions. |
| Q4 | Approve the drop list D1 to D14? | Yes. Each is unused or legacy; reasons are in section 4.5. |
| Q5 | Two Tigeryard boards still run from pinned copies (Remilytics on port 58307, decomp on 8793), and RemiNET has a Tigeryard-named health sync. Migrate their data to Politburo boards, or leave them on the pinned copies after the archive? | Leave them pinned for now; decide before step 7.6. |
| Q6 | Setup script: keep pasting each version, or paste once a small stub that fetches a pinned version? And will you create a canary cloud environment for step 4.4? | Canary: yes. Stub: later, after v11 is proven. |
| Q7 | Script-only secretaries (core-0069) now wait for Phase 3 so the swarm switches once. Until then the Haiku secretaries keep running. OK? | Yes. Switching twice costs more than the interim tokens. |
| Q8 | After wind-down, does the Politburo spawner own the swarm layer alone, or does a second spawner work in the Politburo repo on `packages/swarm` only? | Decide at G5, with throughput data. |

## 9. How I gate

- I read the evidence myself: PR heads and checks with `gh`, the parity runner output, the mail log, the shadow diffs.
- PROCEED and HOLD go as `spawner.decide` mail to `pb` and `ty`. A HOLD lists each failed check by matrix row.
- I grant each cutover C1 to C12 separately. Steps 7.3 and 7.6 also need bonklek's OK through core.
- Log: `logs/mg.log`, one line per event.

## 10. Addendum: corrections after the freeze acknowledgements (2026-11-22 08:55Z)

Both spawners acknowledged the freeze (pb-0021, ty-0680). Politburo sent no inventory corrections. Tigeryard sent ty-0682 (checked by a Haiku agent against `origin/main`, not by hand; an ID-level check found every one of the 219 inventory IDs in the matrix). None changes a verdict. How each item maps:

| Tigeryard correction | Effect on the matrix |
| --- | --- |
| `supervisor/usage.py` (SUP-39) is imported by `adapters/pi.py`; `resources.py` (SUP-21) re-exports the check runner to live callers; `context_packets.py` (SUP-30) and `outcome_links.py` (SUP-40) have more importers than listed | "Used by nobody" was wrong for these as code, but all callers are in the old local-CLI model. M35, M38, M42 keep their verdicts. D3 (context packets) stays a proposed drop; its importers (`adapters/devin.py`, `preimpl_audit.py`) are themselves D4 and D6. |
| SEC-20 has a test (`supervisor/test_secretary_exceptions.py`) | M19's parity case uses it. |
| Missing: `supervisor/git_hardened.py` | Imported only by the QA broker; added to D1. |
| Missing: replay engine, oracle, scenarios, world | Part of M45 and the M32 acceptance test. |
| Missing: `decisions/0002`, `decisions/0003`, and nine docs not cited | Inputs to the policy doc set, M03, and to the Phase 6 designs. The Tigeryard spawner lists what each rules in step 2.2. |
| Missing: `SECURITY.md` checks before every commit and push | Part of M27 (privacy preflight) and the git rules in M03. |
| Missing: `bin/tigeryard` wrapper | Replaced by the swarm layer's one CLI (section 2, L4). |

Open with core: mg-0005. core-0112 (land Tigeryard PRs 56 and 57, pilot `secretaryd` on `rml`) was written before the freeze and conflicts with it. The hold stays until core answers.

Politburo's `bench.json` request (pb-0021, formerly pb-0010) is the field list for M24: sprite, model, thinking, start, end, exit code, turns, tool calls, tokens (in, out, reasoning, cached), files and lines changed, attempt number, machine-readable exit reason.

## 11. bonklek's decisions on section 8 (2026-11-22), and what replaces this plan

**This plan is superseded by `merger-plan-v2.md`**, written after bonklek reviewed it in direct conversation and changed the architecture. This file is kept for the record and for its capability matrix (section 4), which version 2 cites by row.

| Q | Decision |
| --- | --- |
| Q1 | New package `packages/swarm`. "Tigeryard" survives as the layer's product name in docs. Design to minimise friction for the package. |
| Q2 | Move the pi router and shell helpers as they are. "No copying" is a guideline. No permanent test bloat. |
| Q3 | Mobs do not reach a board; a local mirror posts for them. People reach boards through a Cloudflare Tunnel, any company email valid. Boards on the office Mac Studio. |
| Q4 | Nothing is dropped for being unused. Each part is judged by design intent and the idea carried to a named place. No per-agent adapters: everything runs through pi. Non-code work is redesigned as a capability. |
| Q5 | The Remilytics and decomp boards get a one-time migration pathway owned by their spawners; the tool is temporary. |
| Q6 | Environment renamed `politburo`; canary environment; paste now, pinned stub later; core makes the clicks through the browser and can edit the whole swarm's configuration. |
| Q7 | Replaced: model-free secretary built first, Jev (TypeSafe API) as classifier, Terra (pi, OpenAI subscription) as rare adviser, Haiku secretaries retire per tag after shadow. p0 never classified. Rate bar of one late p1 per 500 per question. |
| Q8 | Dissolved: the Politburo spawner maintains the Politburo repo, `packages/swarm` included. Swarm-wide configuration is core's. |

Further rulings in the same conversation (parties, labels, party config tree, claim rule, work board redesign, trackers, non-adoption, scoring, three-character tags) are in version 2, section 1.
