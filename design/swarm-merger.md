status: proposed
bonklek decides on this PR

# Tigeryard in Politburo

Tigeryard is the name of the swarm layer inside Politburo, the new workspace package `packages/swarm`.
Each party has a party board (Standing Committee) and shares a repo board (work board) with the other parties on each repo.
This design sets the package boundary, the board topology and the rules each service follows, before any code.

## Status

The 23 decisions (D1 to D23) are bonklek's, taken on 2026-11-22. This design builds on them and reopens none. The PR is a design, not an implementation (WP-101).

"The plan" in these documents is the merger plan, version 2, of 2026-11-22. It is not in this repository. A cite such as "plan 3.4" is its section number, "D20" is a decision of its section 1, "WP-402" is a work package of its section 7, and "M05" is a row of the capability matrix of the first plan. The [decision check](#decision-check) restates each decision, so a reader here needs only this repo.

| Doc | Holds |
| --- | --- |
| [Swarm mail](swarm-mail.md) | Inbox threads, relay, and the temporary file bridge. |
| [Party config](swarm-party-config.md) | Defaults, validation, notices and audit. |
| [board additions](swarm-board-additions.md) | What the board must enforce or expose. |
| [Reuse](swarm-reuse.md) | Which existing code each work package builds on. |
| [Spend](swarm-spend.md) | Dispatch envelope, ledger record and limits. |
| [Work items](swarm-work-items.md) | Outcomes contract, claim rule and board groups. |

## Packages and their rules

The workspace includes `packages/*` (`pnpm-workspace.yaml:2`). The current packages declare `@vercel/board` and the private `@remilia/politburo-runtime` (`packages/board/package.json:2`, `packages/runtime/package.json:2-4`, `AGENTS.md:3-7`).

| Layer | Path | Holds | Rule |
| --- | --- | --- | --- |
| board core | `packages/board/src` except `inspect` | Threads, labels, blocks, tasks, claims, attention, pause and grants. | Only server-enforced rules go here. Batch the smallest additions in WP-101 (plan 3.1). |
| UI | `packages/board/src/inspect` | Party board, repo view (Presidium), shared repo board, mob view (Cell), settings. | Reads only the board handle. |
| Runtime library | `packages/runtime` | Runner, review gate, watcher poll, usage guard, capacity and scoreboard functions. | Stays a library. |
| Swarm layer | `packages/swarm` | Party config, tag registry, mail, secretary service, relay, bridge, ledger, tracker adapters, mirror, sprite tools, setup build, skills, policies and processes that host runtime functions. One CLI, `swarm`. | Uses the public board handle (`board()` of `@vercel/board`) and `@remilia/politburo-runtime` only. |

Dependencies point from swarm to the public board handle and runtime, and from the UI to the handle. Nothing in `packages/board` imports `packages/swarm`. No swarm code reaches board internals. WP-102 adds the check; this doc only states the rule (plan 3.1, plan 7). The Politburo spawner maintains this repo, including `packages/swarm`. Core (Party Chairman) owns swarm-wide config (D23).

## Boards

| Board | One per | Process | Holds and channels |
| --- | --- | --- | --- |
| Party board | Party | `swarm serve`, own directory and port | Core's inbox, cross-repo traffic, config, limits, spend roll-up, decisions by the jockey (jockey), and pause. |
| Repo board | Repo | `swarm serve`, own directory and port | `intake`; `work/...` for work items, claims and tracker links; `mirror/...` for every PR and branch; `party/<party-id>/{inbox,outbox,mobs,decisions,spend}` for each party. |

Design choice: a board process is `swarm serve`, not stock `vb serve --swarm` (plan 3.2 names the latter). It builds the same board from public pieces, with the options of `--swarm`, so it can take a custom `authenticate` for the tunnel; stock `vb serve` cannot. The reasoning and the lines are in [board additions](swarm-board-additions.md#one-hosting-fact-that-is-not-a-board-change).

Design choice: use `inbox`, `outbox`, `config`, `decisions` and `spend` on the party board so each record has an obvious grant boundary. Cross-repo mail lands in `inbox`; limits come from `config`, and pause is a board control rather than a channel.

The repo view is a party filter plus its channels on the shared repo board, not another process. The mob view is the view of one mob's threads inside that repo view (plan 3.2, D18, D19). Colleagues submit to repo intake. The secretary routes to the spawner, which approves or denies without waiting for a human (D6, plan 7 WP-401).

On main `vb serve --swarm` starts one local SQLite board: the CLI passes the switch into the local server (`packages/board/src/cli/local.ts:88`), which gives the feature options to `local()` (`packages/board/src/cli/serve.ts:172-187`). The switch enables agent ops, makes the local owner an attention responder and sets Politburo protocol version 1; it conflicts with `--team-tokens` (`packages/board/src/cli/swarm.ts:9-27`). It does not start a party or repo service; `swarm serve` does, one process per board (plan 3.2, 3.3).

The model-free relay delivers addressed mail at least once using the sender's message ID as the idempotency key. Both boards record delivery. A board outage stops only traffic involving that board. See [Swarm mail](swarm-mail.md#relay-between-boards) for the transport and recovery (plan 3.2, 6.1).

## Hosting and access

| Kind | What |
| --- | --- |
| Deployment facts set by the plan (D4, D5, plan 3.3) | The always-on office Mac Studio is the host. People enter through a named Cloudflare Tunnel with Access set to "any company email". Cloud mobs do not connect to boards. These are deployment premises, not evidence of an installed service. |
| Host design (plan 3.3, WP-112) | System services for the boards, relay, secretary services, ledger, mirror and watch start at boot without login and restart after power loss. Take online SQLite backups and prove restore in a second directory. The hosting research note, section 5, supplies the runbook input. |
| Identity design (plan 3.3, WP-113) | Verify the signed Cloudflare assertion, including signature, issuer, audience and expiry. Map the verified email to the colleague's board principal, never the owner. A party registry in swarm maps members and roles to board grants. Admission to the tunnel does not grant party access. |
| Cloud design (plan 3.3, WP-111) | Cloud mobs push branches, open PRs and write a status file on a Git branch. The mirror posts on their behalf. A narrow write-only telemetry receiver behind the tunnel accepts a machine credential, not a board credential. |

The verifier can live in `packages/swarm` as the board host's `authenticate` implementation. `BoardOptions` includes `PolicyOptions`; the hook receives request headers and can return a host principal. It replaces the default `oidcTokens()` verifier, so any existing API credential path must still be deliberately supported and checked by the host (`packages/board/src/server/board.ts:19`, `packages/board/src/server/policy.ts:33-43,88-98,156-159`, `packages/board/src/server/auth.ts:22-29,600-627`). Board policy still works out grants (`packages/board/src/server/policy.ts:202-210`). A host can serve the API through the handle's `fetch` without adding a board auth API (`packages/board/src/server/board.ts:257-258,320,369`).

Stock `vb serve --swarm` cannot load that hook from swarm: its serve path supplies its own verifier and its inspector is wired to the local client plus its visitor hook (`packages/board/src/cli/serve.ts:181-187,218-223`, `packages/board/src/cli/local.ts:105-109`). So the Mac Studio runs `swarm serve`, which builds the board from public exports and needs no board change; the inspector's visitor identity is a UI change, listed apart in [board additions](swarm-board-additions.md#outside-this-list-the-inspector). A colleague who signs in maps to a board principal of kind `person` with its own explicit `user` grants: a host principal of any other kind is refused by the code (`packages/board/src/server/auth.ts:495`), and a host `person` receives every permission through the starting grant until that grant is revoked (`packages/board/src/server/trust.ts:56-65`), which a swarm board does when it is created. Details and the SPEC disagreement are in [board additions](swarm-board-additions.md#one-hosting-fact-that-is-not-a-board-change). The UI path must act as the verified visitor and refuse an unsigned request, with no owner fallback. Until WP-113 passes, colleagues run `vb inspect` locally against the board API; the server-side inspector stays off the tunnel (plan 3.3, WP-113).

## Vocabulary

| Thing | Default label | Plain name used in code |
| --- | --- | --- |
| The product and its one UI | Politburo | `politburo` |
| One complete hierarchy with a name and colour | Party | `party` |
| The human above core | jockey | `jockey` |
| Core | Party Chairman | `core` |
| The party's top board: all its spawners, config, roll-up | Standing Committee | `party board` |
| One party's view of one repo, where you talk to its spawner | Presidium | `repo view` |
| The board all parties on a repo share | work board | `repo board` |
| One mob's view | Cell | `mob view` |
| Secretary, mob, sprite | secretary, mob, sprite | same |

Code, filenames, commands and schema fields use the plain names. The UI shows party labels with plain subtitles, such as "Presidium: acme/web repo". Mob species, sprite items, secretary and spawner names are config pools, not constants (plan 2, 4).

## Spend ledger

One append-only ledger on the Mac Studio is the accounting authority for a party. Boards show projections. An envelope binds each attempt to party, repo, work item, tier, parent, session and trace before dispatch. Roll up sprite through mob, work item, spawner and repo to party (plan 3.4, D8).

| Meter | What it means |
| --- | --- |
| Reported tokens | Exact as reported. Sources are pi usage events, local Claude Code telemetry checked against transcripts, cloud telemetry only if proved, and Jev and Terra calls. |
| Priced usage | Usage share in the subscription window times its share of the subscription price. |
| Settled charges | Actual charges where a bill exists. |

Missing data stays unknown. Reserve against versioned limits by party, repo, submitter, tier and work item before launch. The jockey can stop at every level; a running cloud mob can be observed and stopped, not capped mid-run. See [Spend](swarm-spend.md) (plan 3.4).

## The five design rules

| Rule (plan 3.5) | Meaning in swarm | Example |
| --- | --- | --- |
| Bind proof to the thing it proves. | Keep evidence tied to the exact candidate. | A check proves only the commit it ran on. |
| Separate observation from authority. | A receipt informs a decision but cannot grant one. | A mirrored PR status is not permission to merge. |
| Make restart safe. | Record identity before side effects and reconcile uncertain work before retry. | Write the dispatch envelope before launch. |
| Unknown is not false or zero. | Carry gaps through records and projections. | Unreported mob spend is unknown, not zero. |
| Spend attention only on exceptions. | Use rules before a model or a person. | Route p0 without asking Jev. |

## The bloat rule

1. A permanent test names an observable failure. Break the code and see it fail, per `AGENTS.md:29-31`.
2. Run gate checks once at cutover. Put evidence in the notes folder under `merger/evidence/`, not the repo.
3. Keep parity cases in `packages/swarm/parity/` only through cutover; WP-803 removes them. Migration tools live outside the repo.
4. WP-102 counts swarm source and test lines separately beside the fork-thinness judge. Core may HOLD on unexplained growth.
5. Keep tests and research notes out of all tiers' startup reading.

Use board primitives and runtime functions before adding helpers. This design keeps models, delivery and policy out of board core; [Reuse](swarm-reuse.md) traces what moves or stays. Core judges the gates on evidence (D2, D3, plan 3.6, 8).

## Secretary service and Jev and Terra

Run one model-free service per spawner. Its first purpose is to save spawner tokens. Haiku secretaries retire per tag after the shadow and soak pass (D16, plan 6.2, WP-207).

| Duty | Who |
| --- | --- |
| Deliver, validate, dedupe, expire and reject with reason | Rules |
| Route p0 now, p1 within the configured window, p2 and p3 into digest | Rules |
| Wake the spawner and record delivered or not | Rules |
| Compile a small case packet with only the facts needed | Rules; Terra rarely advises |
| Check-and-push, retire check, CI status, rollout acks and PR state | Rules |
| Reduce long mob reports to fixed fields | Jev |
| Classify what can wait, subject to thresholds | Jev |

Per spawner the ledger gives tokens per merged PR, wakes per day, tokens per wake, and late or missed p0 and p1 (plan 6.2).

| Question (plan 6.3) | Ask | Costly direction |
| --- | --- | --- |
| J1 | Which repo and spawner, from the ones the submitter may use? The candidates come from the submitter's current grants before classification, and the choice is checked against them again before delivery. | Wrong repo sees the text. |
| J2 | Does it need the spawner at all? | Drop a real ask. |
| J3 | Can it wait for the next heartbeat? | Hold something urgent. |
| J4 | Does stated urgency match content? Raise freely; lower p1 last. | Lower a real p1. |
| J5 | Is this mob report clean with links or does it need a decision? | Call a blocked report clean. |
| J6 | Is it the same thing as one already handled? | Drop a new fact. |
| J7 | Is it still relevant given later events? | Drop a live item. |
| J8 | Who handles it: secretary, spawner, Terra or core? | Under-escalate. |
| J9 | Is the outcomes contract complete? | Pass an uncheckable ticket. |
| J10 | Does a review finding touch a named invariant of the brief? | Call a blocker minor. |

The secretary calls Jev through the TypeSafe API directly for one question at a time. It receives a short excerpt and fixed choices, never code, patches, credentials or another repo's content. It returns a label and probabilities, never an action. Terra runs through pi on the OpenAI subscription. It gets one stateless case packet (about 3,200 tokens by default, a config value) and a fixed answer format, no tools or session history. It never pushes, merges, retires or answers for the jockey. Plan D16 fixes the pi route even where the routing research explores direct Terra APIs. If either model is unavailable, mail still delivers and the spawner is woken. Never classify p0; always forward it (D16, D17, plan 6.3).

Each question starts in shadow: record what it would do next to what the spawner did. It goes live only when the costly mistake stays within the bar. D17 starts at at most one late p1 per 500 classified messages per question. A breach automatically switches the question back to shadow. Log prompt version, label, probability, action and outcome. Below confidence, wake the spawner. Core reviews the data regularly and tunes prompts and thresholds in [Party config](swarm-party-config.md) (plan 6.3).

## Trackers, mirror and overlap, sprite layer and setup distribution, scoring

### Trackers, mirror and overlap

- Multiple sources per repo: beads, Linear, GitHub Issues and native board tasks. Adapters run `scan` and `get` on the Studio, one writer per repo. Native tasks need no adapter. Mobs have no tracker credentials. Repo config lists sources and precedence (D9, plan 6.5).
- Git and GitHub are ground truth for work inside and outside Politburo. Mirror every PR, branch and issue. Check `origin`, open PRs including drafts, and linked tracker items before dispatch. A partial read does not clear overlap (D7, plan 6.5).
- Read first. Enable writes per repo, `comment` before `transition`. Remilia World's beads stay Charlie's, read-only, with no `bd` push or store changes (plan 6.5).

### Sprite layer and setup distribution

- Move the pi router and `pi-task`, `sprite-start`, `sprite-watch`, `sprite-stop` and `pi-auth-ensure` as they are to `packages/swarm/sprite/`. Keep the router's existing tests and one small helper exit-code test file. All coding agents use pi, not per-agent adapters; the cloud launch stays (D2, D11, plan 5, 6.6).
- One build command makes the setup script. v11 matches v10 behavior; v12 adds telemetry and bench fields (plan 6.6).
- Core uses the browser to rename `remidarknet` to the default `politburo` and create the default `politburo-canary`. A fixed canary check mob passes before production. Record changes on the party board. Core pastes the chosen version into the canary environment, runs the fixed check mob, and pastes the same version into production only after it passes; each change is a record on the party board. A later stub fetches a pinned hash-checked bundle, reports its version and reverts the pin on first production failures. Secrets stay in the environment form (D15, plan 6.6).

### Scoring

- Use the ledger and outcome records. Score merged work that stays merged, tokens per merged PR, review rounds, reverts, human minutes and missed claims. Unknown spend counts against a score (D19, plan 6.7).
- Levels, milestones and leaderboard are per party; history is a report with drill-down. Never sort the shared queue by score (plan 6.7).

### Where the ideas go

D10 carries each Tigeryard idea to a named place (plan 11):

| Old item | Carried into |
| --- | --- |
| QA broker | WP-601 gates, WP-502 check runner |
| Adapter wrapper | The runtime harness contract |
| Context packets, source lifecycle | WP-108 and WP-206 case packet; tracker adapters |
| Pre-implementation audit | WP-107 overlap check |
| Handoff delta | WP-601 |
| Devin adapter | WP-602 launch recovery |
| Old formats and aliases | Party config labels; cutover readers |
| Scheduler tables, review marks, notification attempts | WP-103 ledger; wake receipts; human minutes in scoring |
| Convergence routing, loop boundaries | WP-108 wake rules |
| Operational outcomes | WP-408 |
| Provider pool, history import, pi setup | Model routes in config; WP-801; onboarding |
| Startup budget, module inventory | WP-102 line count; the secretary scorecard |
| Service templates, CI, contracts index | WP-112, WP-502 |
| Old storage and migration | WP-801; tracker mapping |

### Work items and coverage

- [Work items](swarm-work-items.md) owns plan 6.4 and WP-404. Non-code work declares outcomes and proof. The queue groups by who acts next, in a dense list by default. Work from outside Politburo has no party. The old eight columns are not rebuilt (D12, D21, plan 5, 6.4).
- The work board research proposes a 30-minute reclaim block and a commitment-plus-renewal claim. D20 fixes 15 minutes and a four-hour hard cutoff satisfied by any listed acceptable outcome. Keep the ordinary short liveness lease. No downtime pause (plan 6.4).
- Keep M01 to M80 of the first plan as coverage, subject to plan 5: old Drop rows carry ideas to the named destinations in plan 11, M34 uses pi, M08 goes rules-first, M24 and M42 become the ledger, M70 to M78 become the new work board. New capabilities sit alongside the matrix; no row is dropped for disuse (D10).

## Decision check

| Decision | Where | How |
| --- | --- | --- |
| D1 Swarm workspace | [Packages and their rules](#packages-and-their-rules) | `packages/swarm` is a new workspace package; Tigeryard survives as the layer's product name in docs; the layer is designed for the least friction with the board. |
| D2 Close port allowed | [Sprite layer and setup distribution](#sprite-layer-and-setup-distribution) | Not copying code is a guideline: the pi router and helpers move as they are, and a close port is allowed where it is safer than a new design. |
| D3 No permanent bloat | [The bloat rule](#the-bloat-rule) | Gate evidence and temporary parity. |
| D4 Cloud and people access | [Hosting and access](#hosting-and-access) | Git mirror for mobs, tunnel for people. |
| D5 Studio host | [Hosting and access](#hosting-and-access) | System services on office host. |
| D6 Repo intake | [Boards](#boards) | Secretary routes; spawner decides. |
| D7 Outside work | [Trackers, mirror and overlap](#trackers-mirror-and-overlap) | Git and GitHub ground truth. |
| D8 Every tier's spend | [Spend ledger](#spend-ledger), [Spend](swarm-spend.md#sources-and-reconciliation) | Every tier and task, rolled up the hierarchy; exact tokens, derived dollars, unknown never zero; limits set ahead of time and live; the jockey can intervene. |
| D9 Multiple trackers | [Trackers, mirror and overlap](#trackers-mirror-and-overlap) | Per-repo sources and precedence. |
| D10 Carry intent | [Work items and coverage](#work-items-and-coverage), [Where the ideas go](#where-the-ideas-go) | Nothing is dropped for being unused; each idea has a named place. |
| D11 Single harness | [Sprite layer and setup distribution](#sprite-layer-and-setup-distribution) | pi for coding agents. |
| D12 Non-code outcomes | [Work items and coverage](#work-items-and-coverage) | Declare outcome and proof. |
| D13 One-time import | [The bloat rule](#the-bloat-rule), [Open](#open) | WP-801 uses temporary tooling under the old boards' spawners. |
| D14 Three-character tags | [Tags and cutover](#tags-and-cutover) | Registry and cutover rename. |
| D15 Cloud setup | [Sprite layer and setup distribution](#sprite-layer-and-setup-distribution), [Packages and their rules](#packages-and-their-rules) | `remidarknet` becomes `politburo`, a canary exists, core clicks through the browser and can edit the whole swarm's configuration. |
| D16 Rules first | [Secretary service and Jev and Terra](#secretary-service-and-jev-and-terra) | Optional classifier and rare adviser. |
| D17 Never classify p0 | [Secretary service and Jev and Terra](#secretary-service-and-jev-and-terra) | Shadow by question, automatic switch-back. |
| D18 Vocabulary | [Vocabulary](#vocabulary), [Boards](#boards) | Plain names in code, views not processes. |
| D19 Shared board and scoring | [Boards](#boards), [Scoring](#scoring) | One hierarchy per party; score outcomes. |
| D20 Claim cutoff | [Claim rule](swarm-work-items.md#claim-rule) | 4 hours (config) on the board's clock, hard cutoff, no downtime pause; any listed outcome satisfies; a miss releases, docks and blocks the party's reclaim for 15 minutes (config). |
| D21 Dense queue | [Board groups](swarm-work-items.md#board-groups) | Grouped by who acts next, dense list by default, replacing the eight columns. |
| D22 Party config | [The tree](swarm-party-config.md#the-tree), [Layering](swarm-party-config.md#layering), [Validation](swarm-party-config.md#validation), [Audit and revert](swarm-party-config.md#audit-and-revert) | Every label, pool and interaction rule in one tree, edited in the UI or by an agent; bonklek's labels are the defaults. |
| D23 Repo and config ownership | [Packages and their rules](#packages-and-their-rules) | Spawner maintains repo; core edits policy. |

### Tags and cutover

The registry requires unique three-character repo tags, consonants preferred. Rename at each mail cutover; historical IDs stay valid. The initial mappings are `plb` for Politburo, `rml` for Remilytics, `kgm` for Kagami, `rdn` for RemiDarkNET and `rmw` for Remilia World. Remilia World bead IDs keep `rw-` (D14, plan 12 item 7, WP-102, WP-202, WP-203).

## Choices made without asking

| Plan 12 | Choice and where it lands |
| --- | --- |
| 1 | Repo view is a filter and channels, not a process; this design builds on it in [Boards](#boards). |
| 2 | One party board per party; first party is bonklek's, `default` until named; this design builds on it in [Party config](swarm-party-config.md). |
| 3 | Core judges gates; `mg` is called at the end; this design builds on it in [The bloat rule](#the-bloat-rule). |
| 4 | Repo board clock sets cutoff; ordinary short lease still applies; this design builds on it in [Work items](swarm-work-items.md). |
| 5 | Invalid or missing outcomes contract blocks claims; this design builds on it in [Work items](swarm-work-items.md). |
| 6 | Start with two open claims per party per repo, one uncommitted; this design builds on it in [Party config](swarm-party-config.md). |
| 7 | Rename tags at mail cutover, preserve history and `rw-` bead IDs; this design builds on it in [Tags and cutover](#tags-and-cutover) and [Swarm mail](swarm-mail.md). |
| 8 | Terra's default is `openai-codex/gpt-5.6-terra`, the default of `tiers.models.adviser` in config, not a constant; test `gpt-6.1-terra` beside it in WP-206; this design builds on it in [Party config](swarm-party-config.md). |
| 9 | The Tigeryard spawner submits parity PRs to Politburo under `packages/swarm/parity/**` only; this design builds on it in [The bloat rule](#the-bloat-rule). |
| 10 | Scoring is Phase 7; schemas carry party ID and outcome records from Phase 1; this design builds on it in [Work items](swarm-work-items.md) and [Spend](swarm-spend.md). |
| 11 | Initial Jev thresholds are placeholders; shadow data sets real values; this design builds on it in [Party config](swarm-party-config.md). |
| 12 | Cloud mob telemetry is unproven; failure of WP-111 means unknown mob spend, marked in the ledger; this design builds on it in [Spend](swarm-spend.md). |

## Open

Plan 10: core files each ask in `mail/bonklek/` and proceeds. None stops a phase from starting.

| Who | What | Blocks only |
| --- | --- | --- |
| bonklek | A domain on Cloudflare for the tunnel and the Access rule "any company email". | WP-113, WP-111 |
| bonklek | A TypeSafe API key on the Mac Studio for Jev. | WP-205 beyond a stub |
| Charlie | Agreement to a read-only view of Remilia World's beads, and how claims are shared with his workers. | WP-114 |
| bonklek | Access for core or a named person to install services on the Mac Studio. | G1 host check |
| bonklek | Who owns the decomp research board. | WP-801 for that board |
| bonklek | OK to retire the Tigeryard spawner and archive its repo. | WP-804, WP-805 |

WP-801 gives the old Remilytics and decomp boards a one-time dry-run, verify and switch or export-and-stop path under their own spawners. Delete the tool afterward (D13, plan 7).

Found here: plan 3.2 specifies `vb serve --swarm`; this design runs `swarm serve` instead (see [Boards](#boards)). Core confirms that choice when it reviews WP-112 and WP-113.

Found here: the board additions list is empty of required items and carries four deferred ones. Core confirms that reading of D20, "the board ends the claim", as the board's own lease expiry (see [board additions](swarm-board-additions.md#open)).

## Replaces

These files stay as the record and carry a pointer. Existing tier text and naming conventions stay.

| Record | Part replaced or corrected | Pointer |
| --- | --- | --- |
| [Tigeryard parity](../TIGERYARD-PARITY.md) | Whole as the statement of intent; its status table is stale. | [Status](#status), plan 5 and 11 |
| [Swarm architecture](swarm-architecture.md#3-messaging) | Section 3's old operational inbox transport line; tier text stays. | [Swarm mail](swarm-mail.md#what-changes) |
| [Swarm secretaries](swarm-secretaries.md) | Transport and channel names. | [Swarm mail](swarm-mail.md) |
| [Swarm frontend](swarm-frontend.md#mapping) | Channel mapping rows and scopes. Page layout is replaced by plan 6.4 and WP-404. | [Boards](#boards), [Work items](swarm-work-items.md) |
| [Swarm naming](swarm-naming.md) | Pools move into config as data. Conventions stay. | [Party config](swarm-party-config.md#the-tree) |
