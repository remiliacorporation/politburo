# Tigeryard into Politburo: implementation plan, version 2

Author: merger coordinator (mail tag `mg`). Written 2026-11-22.
Status: **approved to execute.** bonklek reviewed the first plan in direct conversation on 2026-11-22, changed its architecture, and said: write the full plan, hand it to the spawners' secretaries, they carry it out end to end, no stopping for questions. This version replaces `merger-plan.md` (kept beside it for the record). The freeze of 2026-11-22 is replaced by section 9.

Evidence (all in `merger/research/`; nothing in them was run or tested live):

| File | Covers |
| --- | --- |
| `tigeryard-inventory.md` | 219 Tigeryard capabilities (IDs `UI-`, `BRD-`, `SUP-`, `SEC-`, `SPR-`, `SKL-`, `POL-`) |
| `politburo-inventory.md` | What Politburo has today (IDs `PB-`) |
| `live-dependencies.md` | What the live swarm runs on |
| `drop-list-intent.md` | Design intent of every Tigeryard part not rebuilt as code |
| `sota-boards-topology-hosting.md` | Boards, relay, access, Mac Studio runbook |
| `sota-routing-secretaries.md` | Model-free secretary, Jev, Terra |
| `sota-usage-tracking.md` | Spend ledger, telemetry, limits |
| `sota-task-trackers.md` | Beads, Linear, GitHub Issues, adapters |
| `work-board-redesign.md` | Work board groups, rows, claim rule, old-board mapping |
| `linear-inspiration.md` | Row anatomy, views, keyboard, outcomes contract |
| `naming-three-character-tags.md` | Tag registry |
| `swarm-config-distribution.md` | Setup distribution (arrives later; see addendum when present) |

## 0. How to use this plan

- **Spawners** take the work packages (section 7) assigned to them, in phase order, and dispatch mobs as usual. Each package names its inputs, its output, and the check that proves it. A package with no unmet dependency may start now. Packages in one phase run in parallel unless they name a dependency.
- **Gates** (section 8) are judged by **core** from the evidence each package attaches. Core mails PROCEED or HOLD. `mg` is called at the end for critique, and may be mailed at any time (`mail/mg/`) for a ruling on this plan's meaning.
- **No package waits for bonklek** except the few in section 10. Where this plan had to choose without asking, the choice is listed in section 12; build on it.
- **Live swarm rule:** nothing that the running swarm depends on is switched without its shadow run, its gate, and its rollback. The existing review policy and merge guardrail apply to every PR.
- **Bloat rule:** see section 3.6. It binds every package.

## 1. Decisions (bonklek, 2026-11-22)

| # | Decision |
| --- | --- |
| D1 | The Tigeryard layer is a new workspace package `packages/swarm`. "Tigeryard" survives as the product name of the layer in docs. Design to minimise friction for this package. |
| D2 | "Do not copy code" is a guideline, not a rule. The pi router and the shell helpers move as they are. A close port is allowed where it is safer than a new design. |
| D3 | No permanent test or line-count bloat. Checks are gate checks first. Parity cases and one-time tools are temporary. |
| D4 | Mobs do not reach a board directly; a local mirror posts for them from Git and PRs. People reach boards through a Cloudflare Tunnel where any company email is valid. |
| D5 | Boards are hosted on the always-on Mac Studio in the office. |
| D6 | Colleagues submit work to a repo; the secretary routes it to the spawner, which approves or denies. A human is never the bottleneck. |
| D7 | Assume work also arrives from people who do not use Politburo. Git and GitHub are ground truth. |
| D8 | Resource tracking (tokens, time, other spend) for every tier, per task, rolled up the hierarchy. Token counts exact as reported; dollars derived from the share of subscription used; unknown is never zero. Limits are configurable ahead of time and live. The jockey can always intervene. |
| D9 | A repo may take work from several trackers at once: beads, Linear, GitHub Issues, native board tasks. |
| D10 | Nothing from Tigeryard is dropped for being unused. Each part is judged by its design intent and the idea is carried to a named place (section 11). |
| D11 | Every coding agent runs through pi. No per-agent adapters. |
| D12 | Non-code work (research, reports, ops) is accepted, with declared outcomes and proof. |
| D13 | The old Remilytics and decomp boards get a one-time migration pathway owned by their own spawners. The tool is temporary, not permanent Politburo code. |
| D14 | Every repo tag is three characters, consonants preferred, kept in a registry. Renamed at each tag's mail cutover. `plb` Politburo, `rml` Remilytics, `kgm` Kagami, `rdn` RemiDarkNET, `rmw` Remilia World. |
| D15 | The cloud environment `remidarknet` is renamed `politburo`. A canary environment exists. Core makes the clicks through computer or browser use. Core can edit the whole swarm's configuration. |
| D16 | The secretary's first purpose is to save her spawner's tokens. Model-free code first. Jev (TypeSafe API, direct) classifies single-step questions. Terra (through pi on the OpenAI subscription) is a rare stateless adviser. Haiku secretaries retire per tag after the shadow passes. |
| D17 | p0 mail is never classified; it always forwards. Jev thresholds and prompts live in config, core tunes them, and they are reviewed regularly against data. Starting bar: at most one late p1 per 500 classified messages per question, with automatic switch-off. |
| D18 | Vocabulary (section 2): Politburo, Party, Party Chairman, Standing Committee, Presidium, Cell. One Standing Committee per party. A Cell is a view inside a Presidium. |
| D19 | A **party** is one complete hierarchy with a name and a colour. Several parties share one work board per repo. Party plus telemetry feeds scoring: levels, milestones, leaderboards. |
| D20 | Claim rule: 4 hours, hard cutoff, no pause for downtime. Satisfied by any acceptable outcome listed in the ticket description. On a miss the ticket is released and the party's score is docked. Same-party reclaim after 15 minutes. |
| D21 | The work board replaces Tigeryard's eight columns: grouped by who must act next, dense list by default, Linear as inspiration. |
| D22 | Every label, name pool and interaction rule is party configuration in one standard YAML or JSON tree, editable in the UI or by an agent. bonklek's labels are the defaults. |
| D23 | The Politburo spawner maintains the Politburo repo, `packages/swarm` included, like any repo spawner. Swarm-wide configuration is core's. |

## 2. Vocabulary (the default party's labels)

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

Rules: code, file names, commands and schema fields use the plain names. The UI shows the party's labels, each with a plain subtitle ("Presidium: Remilytics repo"). Mob species, sprite items, secretary names and spawner names are name pools in the party config (section 4), not constants.

## 3. Architecture

### 3.1 Packages

| Layer | Path | Holds | Rule |
| --- | --- | --- | --- |
| Board core | `packages/board/src` (not `inspect`) | Records and enforced rules: threads, labels, blocks, tasks, claims, attention, pause, grants. | Smallest possible change. Only what must be enforced on the server goes here. Batch board additions up front (WP-101). |
| UI | `packages/board/src/inspect` | Standing Committee, Presidium, work board, Cell, settings. | Reads only the board handle. |
| Runtime library | `packages/runtime` | Functions: runner, review gate, watcher poll, usage guard, capacity, scoreboard. | Stays a library. |
| Swarm layer | `packages/swarm` | Party config, tag registry, mail, secretary service, relay, bridge, ledger, tracker adapters, mirror, sprite tools, setup build, skills, policies, the processes that host runtime functions. One CLI, `swarm`. | Uses the public board handle and the runtime only. Nothing in `packages/board` imports it. |

### 3.2 Boards

| Board | One per | Process | Holds |
| --- | --- | --- | --- |
| Party board (Standing Committee) | party | `vb serve --swarm`, own directory and port | Core's mail, cross-repo traffic, the party's config record, limits, spend roll-up, the jockey's decisions, pause |
| Repo board (work board) | repo | `vb serve --swarm`, own directory and port | Intake, work items, claims, the mirror of every PR and branch, tracker links, and for each party on the repo: its spawner's mail, its mobs, its decisions, its spend |

A Presidium is a party's filtered view of a repo board plus that party's channels on it. A Cell is the view of one mob's threads. Channel layout on a repo board: `intake`, `work/…`, `mirror/…`, and `party/<party-id>/{inbox,mobs,decisions,spend}`.

A **relay** (model-free, in `packages/swarm`) delivers addressed mail between boards: at-least-once, with the sender's message id as the idempotency key, and a delivery record on both sides. A board being down stops only that board.

### 3.3 Hosting and access

- **Host:** the office Mac Studio runs every board, the relay, the secretary services, the ledger, the mirror and the watch, as system services that start at boot without a login. Restart after power loss; online SQLite backup; tested restore. Runbook: `sota-boards-topology-hosting.md` section 5.
- **People:** a named Cloudflare Tunnel with Cloudflare Access, rule "any company email". A small layer in the board checks Cloudflare's signed assertion and maps the email to a board principal. Until that layer ships, colleagues run `vb inspect` on their own machine against the board's API; the server-side inspector is not exposed.
- **Cloud mobs:** do not reach boards. They push branches, open PRs and write a status file on a Git branch; the mirror posts for them. A narrow, write-only telemetry receiver sits behind the tunnel with a machine credential (WP-111).
- **Party membership** grants access. A party registry in `packages/swarm` maps members and roles to board grants.

### 3.4 Spend ledger

One append-only ledger on the Mac Studio is the accounting authority for a party; boards show projections of it.

- Every dispatch creates an **envelope** before work starts: `party`, `repo`, `work_id`, `attempt`, `tier`, `parent`, `session`, `trace`. Every spend record carries it, so spend rolls up sprite → mob → work item → spawner → repo → party.
- Three meters, never mixed: reported tokens (exact as reported), priced usage (derived: token share within the subscription window times the window's share of the subscription price), settled charges (where a bill exists).
- Sources: pi's JSON usage events (sprites); Claude Code telemetry request events with the session transcript as cross-check (local sessions); the same export from cloud mobs if WP-111 proves it; Jev and Terra calls from the secretary.
- Missing data is recorded as `unknown`, never zero.
- Limits are versioned rules by scope (party, repo, submitter, tier, work item) in the party config. Dispatch reserves against them before launch. The jockey has a stop at every level. A running cloud mob can be observed and stopped, not capped mid-run.

### 3.5 Design rules for `packages/swarm` (from `drop-list-intent.md`)

1. Bind proof to the thing it proves. A check belongs to one commit.
2. Separate observation from authority. A status or receipt informs a decision; it never grants one.
3. Make restart safe. Record identity before a side effect; never replay uncertain work blindly.
4. Unknown is not false or zero.
5. Spend model and human attention only on the exception. Rules first.

### 3.6 Bloat rule (D3)

- A permanent test names the failure it catches. Break the code, see it fail (AGENTS.md test-behavior skill). Pin nothing a user cannot observe.
- Gate checks run once at a cutover; their evidence goes in the notes folder under `merger/evidence/`, not in the repo.
- Parity cases live in `packages/swarm/parity/` only while their cutover is open, and are deleted in WP-803. Migration tools live outside the repo.
- Lines of code for `packages/swarm`, source and tests separately, are measured next to the fork-thinness judge (WP-102). Core may HOLD a gate on growth without cause.
- Tests and research notes stay out of every tier's startup reading.

## 4. Party configuration (D22)

One tree per party, stored as a versioned record on the party board, validated by a schema, with a JSON and a YAML form. Layering: built-in defaults, then the party's tree, then an optional per-repo override. Every tier reads it at start and on a change notice. Core edits it; the jockey can pin any field. Changes are audited (who, what, why, previous value) and reversible in one step.

```yaml
party:
  id: default            # stable, lowercase; not a person's name
  name: "The People's Party"
  colour: "#b3261e"
labels:                  # shown in the UI; code uses plain names
  product: Politburo
  core: Party Chairman
  party_board: Standing Committee
  repo_view: Presidium
  mob_view: Cell
names:                   # pools are ordered lists; first free name wins
  spawners: [ ... ]      # default: the current spawner pool
  secretaries: [Peggy, Joan, Dawn, Ida, ...]
  mob_species:           # by class and job, as in swarm-naming today
    passive: {audit: [COW, SHEEP, ...], research: [FOX, CAT, OCELOT], ...}
    neutral: {build: [BEE, DOLPHIN], fix: [WOLF, POLAR], ...}
    hostile: { ... }
    boss: [DRAGON, WITHER, WARDEN, ELDERG]
  sprite_items: {implement: [PICKAXE, AXE, ...], review: [SWORD, BOW, ...], ...}
tiers:
  shares: {core: 0.5, spawner: 4.5, mob: 15, sprite: 75}
  models:
    core: ...; spawner: ...; mob: ...
    sprite: {model: fallback/codex-cursor, thinking: medium}
    adviser: openai-codex/gpt-5.6-terra
    classifier: typesafe/jev-1.14
mail:
  classes: [sec.push, sec.retry, sec.retire, sec.log, spawner.dispatch, spawner.decide, core.escalate, policy]
  urgency: {p0: forward_now, p1: {forward_within_minutes: 10}, p2: digest, p3: digest_summary}
  digest_minutes: 30
secretary:
  questions:             # one entry per Jev question (section 6.3)
    can_wait: {enabled: false, prompt_version: 1, threshold: 0.97, on_low_confidence: wake,
               late_p1_rate_limit: "1/500", state: shadow}
claims:
  hours: 4
  pause_on_downtime: false
  reclaim_cooldown_minutes: 15
  open_claims_per_repo: 2
  uncommitted_claims_per_repo: 1
  dock: {missed_claim: 1}
review:                  # the review policy and merge guardrail as rules
  docs_only: {model_review: false}
  code: {review_rounds: 1, fix_rounds: 1}
limits:
  usage_stop_percent: 100
  budgets: []            # {scope, dimension, window, warn, hard}
heartbeat_minutes: 30
setup:
  environment: politburo
  version: {id: v11, sha256: ...}
  canary_environment: politburo-canary
trackers: {}             # per repo: sources and precedence (section 6.5)
```

The Minecraft and Mad Men names, the labels above and the policy numbers are this tree's defaults. Nothing in code hard-codes them.

## 5. Capability coverage

The first plan's matrix (section 4 of `merger-plan.md`) still lists every Tigeryard capability and its acceptance check, by row `M01` to `M80`. Its verdict column changes as follows; the work packages below cite its rows.

- Every "Drop" row `D1` to `D14` becomes "idea carried" (section 11).
- `M34`: no Codex CLI or Devin adapter (D11). pi is the single sprite harness. The Claude cloud launch stays.
- `M08` (script-only secretary) moves first and gains Jev and Terra.
- `M24`, `M42` (telemetry, cost) become the ledger workstream, starting in Phase 1.
- `M70` to `M78` (eight-column UI) are replaced by the work board redesign; the old columns are not rebuilt.
- New capabilities with no Tigeryard row: parties and party config, relay between boards, tracker adapters, all-PR mirror and overlap check, intake from colleagues, non-code outcomes, the claim rule, scoring, setup distribution by core, identity through the tunnel.

## 6. Designs the work packages build

### 6.1 Mail on boards

A message is a thread root with a `swarm-message@1` JSON block and labels `swarm.class`, `swarm.urgency`, `swarm.state`, in the recipient's inbox channel. The sender's id is the post's idempotency key. Dedupe on `[from, ref, class]`. Expiry for p2 and p3 is a field the reader enforces. A two-way **file bridge** keeps `N/mail/<tag>/` current until the last tag has moved, so any tag can fall back. `design/swarm-architecture.md`'s "operational inbox" line is corrected.

### 6.2 Secretary service

A model-free system service per spawner. Events in, actions out:

| Duty | How |
| --- | --- |
| Deliver, validate, dedupe, expire, reject with a reason | Rules |
| Route by header: p0 now, p1 within 10 minutes, p2 and p3 into the digest | Rules |
| Wake the spawner, and record a **wake receipt** (delivered or not) | Rules |
| Compile a small case packet for each wake: only the facts for this decision | Rules; Terra rarely |
| Check-and-push, retire check, CI status, rollout acks, PR state | Rules |
| Reduce long mob reports to fixed fields | Jev |
| Decide what need not wake the spawner now | Jev, under thresholds |

Scorecard per spawner, from the ledger: tokens per merged PR, wakes per day, tokens per wake, and late or missed p0 and p1.

### 6.3 Jev questions

Jev is a classifier: it returns a label and probabilities and never acts. For each question the config holds: labels, the action per label, a threshold, the default below it (always "wake the spawner"), and the costly direction. Each question starts in `shadow` (logged beside what the spawner then did), goes `live` when its costly mistake stays within the rate in D17, and switches itself back to `shadow` when it exceeds it. Every call is logged with prompt version, label, probability, action and outcome.

| # | Question | Costly direction |
| --- | --- | --- |
| J1 | Intake: which repo and spawner, from the ones the submitter may use | Wrong repo sees the text |
| J2 | Does this need the spawner at all | Dropping a real ask |
| J3 | Can it wait for the next heartbeat | Holding something urgent |
| J4 | Does stated urgency match content (raise freely; lowering p1 last) | Lowering a real p1 |
| J5 | Mob report: clean with links, or needs a decision | Calling a blocked report clean |
| J6 | Same thing as one already handled | Dropping a new fact |
| J7 | Still relevant given later events | Dropping a live item |
| J8 | Who handles it: secretary, spawner, Terra, core | Under-escalating |
| J9 | Is the ticket's outcomes contract complete | Passing an uncheckable ticket |
| J10 | Does a review finding touch a named invariant of the brief | Calling a blocker minor |

Jev receives a short excerpt and fixed choices; never code, patches, credentials or another repo's content. Terra receives one case packet of about 3,200 tokens, no tools, a fixed answer format; it advises and never pushes, merges, retires or answers for the jockey. If Jev or Terra is unavailable, mail still delivers and the spawner is woken.

### 6.4 Work items, claims and the work board

- A **work item** is one logical outcome with links to every external item, branch, PR and evidence object that describes it. Links are never inferred from similar titles.
- Its description carries a machine-readable **outcomes contract** (format in `linear-inspiration.md`, "Four-hour acceptable-outcomes contract"). A ticket without a valid contract is not claimable and sits in "Needs you" until fixed.
- **Claim rule (D20):** on claim, a 4-hour clock starts on the board's clock. If a listed outcome validates before it ends, the claim is satisfied and no further clock runs. If not, the board ends the claim, releases the ticket, records a dock against the party, and refuses a reclaim by that party for 15 minutes. No pause. A claim also carries the board's normal short lease, renewed by the live mob, so a dead mob is visible before 4 hours.
- **Caps:** open claims per party per repo, and uncommitted claims per party per repo, from the party config.
- **Board groups**, mutually exclusive, in this order, empty groups hidden: Needs you; Repair or reconcile; Ready to review; Running; Ready to pull; Waiting or parked; Done (hidden by default). Exact rules: `work-board-redesign.md` "Work queue groups".
- **Home**, four short sections in fixed order: Needs you, Ready to review, Running now, Health and spend.
- **Row:** priority, id, title, party colour and name, claimant or Cell, reason, claim countdown, PR and check state, spend with coverage, tracker badges, overlap. Dense list by default; columns optional; keyboard map and saved views per `linear-inspiration.md`.
- **Ids:** `<tag>-<number>`, for example `plb-482`, with source badges (`GH#812`, `LIN ENG-123`, `bd rw-4u5`).
- **Scopes:** Standing Committee (one party, all repos), Presidium (one party, one repo, with an "all parties" switch), Cell (one mob).
- Work from people outside Politburo appears as an observed row with no party.

### 6.5 Trackers, mirror and overlap

- One adapter interface: `scan`, `get`, later `comment` and `transition`. Adapters for beads, GitHub Issues, Linear; native tasks need none. They run on the Mac Studio, one writer per repo. Mobs get no tracker credentials.
- A repo's config lists its sources and which wins when two disagree about the same work item.
- The **mirror** records every PR, branch and issue on the repo, whoever made it.
- The **overlap check** runs before every dispatch: `origin`, open PRs including drafts, and linked tracker items. A partial read does not clear overlap.
- Reads first. Writing back to a tracker is switched on per repo, comments before state changes.
- Remilia World's beads stay Charlie's: read-only, no `bd` push, no change to his store.

### 6.6 Sprite layer and setup distribution

- pi router, `pi-task`, `sprite-start`, `sprite-watch`, `sprite-stop`, `pi-auth-ensure` become real files in `packages/swarm/sprite/`, moved as they are, with one small test file for the helpers' exit codes and the router's existing tests.
- One command builds the setup script from them. v11 equals v10 in behaviour. Telemetry and bench fields are a separate v12.
- Core changes the cloud environment through the browser: rename to `politburo`, create `politburo-canary`, paste a version. Canary first; a fixed check mob must pass before production. Every change is a record on the party board.
- Later, a stub fetches a pinned, hash-checked bundle and reports its version; if the first production mobs on a new version fail, the pin reverts. Secrets stay in the environment form only.

### 6.7 Scoring (D19)

Built from the ledger and outcome records. Score outcomes, not volume: merged work that stays merged, tokens per merged PR, review rounds, reverts, human minutes, missed claims. Unknown spend counts against a score. The shared queue is never sorted by score. Levels, milestones and a leaderboard per party; the history view is a report, with drill-down.

## 7. Work packages

Owner: **plb** = Politburo spawner (mail tag `pb` until its cutover). **ty** = Tigeryard spawner. **core**, **rmw** (tag `rw`), **rml** as named. "Check" is the gate evidence, attached to the PR or put in `merger/evidence/<WP>.md`. Suggested mob class in brackets.

### Phase 1. Foundations (no live change). Start now.

| WP | Owner | Work | Inputs | Check | Needs |
| --- | --- | --- | --- | --- | --- |
| 101 | plb | Design PR [PANDA]: this architecture in `design/`, the corrected mail transport, the party config schema, the dispatch envelope and spend record, the work item and outcomes contract, and **one list of every board addition `packages/swarm` needs**. Mark `TIGERYARD-PARITY.md` and the old `design/swarm-*.md` as replaced. | this plan; all research | Core reads it against section 1; no decision contradicted | — |
| 102 | plb | Package skeleton [GOLEM]: `packages/swarm`, CLI `swarm`, in `pnpm check`; tag registry with a uniqueness check; party config loader, schema, defaults (section 4); line-count measure for source and tests. | 101 | `swarm config show` prints the default tree; a duplicate tag fails the check | 101 |
| 103 | plb | Spend ledger [BEE]: append-only store, envelope creation at dispatch, record ingest, roll-up query by any envelope field, `unknown` handling. | `sota-usage-tracking.md` §4 | Seeded records roll up sprite → party; a missing record shows as unknown, not zero | 101 |
| 104 | ty | Parity cases and behaviour notes [COW, FOX] for mail delivery, routing, digest, expiry, check lock, serial, check-and-push, retire check: inputs and expected outputs recorded from Tigeryard's code, as PRs to Politburo touching only `packages/swarm/parity/**`. Temporary. | Tigeryard `main` | Each case file names the matrix row it proves | 102 |
| 105 | ty | Sprite behaviour note [COW]: exact text of the five helpers and the settings step extracted from setup script v10, every exit code and env name (no values); confirm which router copy is live. | `N/pi-router/` | Note reviewed by plb | — |
| 106 | ty | Live upkeep: bring every secretary's tooling copy to `origin/main` and out of `/private/tmp`; finish PR 58 or park it; retire stopped mobs. | — | Each tag's loop reports its commit | — |
| 107 | plb | All-PR mirror and overlap check, read-only [BEE]: mirror every PR and branch of a repo to its board; `swarm overlap <work-id>` lists conflicts. | `work-board-redesign.md`; D7 | On the Politburo repo, every open PR appears once; a seeded overlapping branch is reported | 102 |
| 108 | plb | Model-free secretary [BEE, WOLF]: section 6.2 without Jev, as a service; wake receipts; scorecard queries. Runs in **shadow** on tag `pb` against file mail from day one. | 104; `sota-routing-secretaries.md` §4–5 | Parity cases pass; 24 h shadow with the same forwards and digests as the live loop | 102, 104 |
| 109 | plb | Sprite usage capture [BEE]: a supervisor around pi that reads final usage events and writes ledger records with the envelope; the Cursor fallback path tested separately. | 105; `sota-usage-tracking.md` §2 | One sprite run yields one record with model, tokens, times, exit reason | 103 |
| 110 | plb | Claude session capture [BEE]: local receiver for Claude Code telemetry request events; transcript cross-check; records for core, spawners, secretaries. | `sota-usage-tracking.md` §1 | One local session's reported tokens match its transcript | 103 |
| 111 | plb, core | Cloud mob telemetry test: receiver behind the tunnel with a machine credential; core sets telemetry settings in the canary environment; one canary mob. Answer: does a cloud mob's export arrive. | 110, 113, 301 | Records for the canary mob, or a written "does not work" with the reason | 110, 113, 301 |
| 112 | plb | Host runbook and service files [GOLEM]: one service per board, relay, secretary, ledger, mirror, watch; boot without login; power-loss restart; online backup and a tested restore. | `sota-boards-topology-hosting.md` §5 | Restore to a second directory succeeds; services survive a reboot (run on the Mac Studio) | 102 |
| 113 | plb | Tunnel and identity [BEE, reviewed once more as security-sensitive]: board layer that verifies Cloudflare's assertion and maps a company email to a principal; machine credential for receivers; inspector stays off the tunnel until this passes. | `sota-boards-topology-hosting.md` §3 | A signed-in colleague acts as themselves in the UI; an unsigned request is refused; the owner is never impersonated | 101, section 10 item 1 |
| 114 | plb, rmw | Read-only beads adapter [BEE] and a shadow of one Remilia World epic: show the queue and why each bead is or is not runnable. No tasks created, no write to the bead store. | `sota-task-trackers.md` | The view matches `bd ready` for the epic, with disagreements listed | 102, section 10 item 3 |

**Gate G1:** 101 to 110 and 112 checked; `pnpm check` green on `main`; the boards for the default party (one party board, one repo board for Politburo) run on the Mac Studio and survive a restart.

### Phase 2. Secretaries and mail (live cutovers, one tag at a time)

| WP | Owner | Work | Check | Needs |
| --- | --- | --- | --- | --- |
| 201 | plb | Mail on boards (6.1), the relay between boards, and the two-way file bridge. | Parity cases; a killed sender leaves no half message; a message crosses two boards exactly once in effect | G1 |
| 202 | plb | **Cutover of `pb`:** the secretary service takes over tag `pb` on its repo board; tag renamed to `plb` at this moment; files stay current through the bridge. | 48 h with zero missed or duplicate p0 and p1; rollback rehearsed in under 5 minutes | 108, 201 |
| 203 | plb with each spawner | Cutover of `ty`, then `rw`→`rmw`, `rml`, `kg`→`kgm`, `rdn` (and `peggy`), at least 12 h apart, each with its own repo board. | 12 h soak each; rollout ledger shows every ack | 202 |
| 204 | plb, core | Cutover of core's mail to the party board; `swarm mail send` replaces `core_mail.sh`. | Core sends to one tag and to all; each arrives once | 203 |
| 205 | plb | Jev client (TypeSafe API, direct) and questions J1 to J10 in shadow; logging; the per-question switch; the review report core reads. | Each question has labelled shadow data; a forced breach switches the question to shadow | 108, section 10 item 2 |
| 206 | plb | Terra adviser: case packet compiler, fixed answer format, audit record; called through pi on the OpenAI subscription. | A seeded exception produces one packet under the size cap and one audited answer | 205 |
| 207 | core | Retire each tag's Haiku secretary after its soak; replace `core-watch.sh`'s stuck-secretary check with the service's liveness. | Per tag: 24 h after retirement with no missed forward | 202–204 |
| 208 | plb, ty | Documents and skills: mob-creation, spawner, mob, research and reviewer skills, brief template with the outcomes contract and the envelope, policies generated from the party config; a sync command installs them. ty reviews against Tigeryard `main` and the notes-folder rulings. Core installs. | Installed skill has no link to the Tigeryard repo; each spawner starts one mob from it | 102 |
| 209 | plb | Rollout tool (entries, notices, acks, stale ledger), swarm serial and name allocation from the party config's pools. | 100 concurrent serials are distinct and continue the live counter | 201 |

**Gate G2:** every tag on the secretary service; all Haiku secretaries retired or a named reason why not; the scorecard shows each spawner's tokens per wake before and after.

### Phase 3. Sprite layer and cloud environment (may run beside Phase 2)

| WP | Owner | Work | Check | Needs |
| --- | --- | --- | --- | --- |
| 301 | core | Through the browser: create `politburo-canary`; rename `remidarknet` to `politburo` in one step with a notice to every spawner. | A mob starts in each; every spawner acks the new name | 208 (skill names the environment) |
| 302 | plb | Router and helpers into `packages/swarm/sprite/`, moved as they are; the build command; v11. | Built v11 installs the same versions as v10; helper exit codes match the behaviour note | 105 |
| 303 | plb, core | Canary run of v11: one mob, three sprites, one forced failover, one idle stop. Then core pastes v11 into `politburo`. | Canary report clean; first three production mobs complete | 301, 302 |
| 304 | plb | v12: usage capture (109) and bench fields at sprite exit; mob scripts from Tigeryard PR 50; telemetry settings if 111 passed. | One mob's sprites and, if proven, the mob itself appear in the ledger | 303, 109, 111 |
| 305 | plb | Setup stub: pinned, hash-checked bundle; version report; automatic revert; core edits the pin in the party config. | A bad canary version never reaches production; a forced failure reverts the pin | 303; `swarm-config-distribution.md` |

**Gate G3:** production mobs run a Politburo-built setup; core has changed a setup version end to end without bonklek.

### Phase 4. Work board, parties and the UI

| WP | Owner | Work | Check | Needs |
| --- | --- | --- | --- | --- |
| 401 | plb | Work items, links, the outcomes contract and its validator; intake channel; spawner approve or deny; J9 at the door. | A ticket with no valid contract cannot be claimed; a valid one can | G1 |
| 402 | plb | The claim rule in the board (D20) and the caps. Board additions from WP-101's list. | Two simultaneous claims make one; a 4-hour miss releases, docks and blocks reclaim for 15 minutes; a validated outcome stops the clock | 401 |
| 403 | plb | Parties: registry, membership to grants, party id on every record, colour and name in the UI. | Two seeded parties work one repo board; every row shows the right party | 401 |
| 404 | plb | UI: the work board (groups, home sections, row, peek, filters, keyboard, saved views), then Standing Committee, Presidium, Cell. Labels from the party config. The old "Presidium" page is replaced. | bonklek's four questions answered on one screen; live updates never move the reader or clobber a draft | 402, 403 |
| 405 | plb | Party config editor in settings, and the same edits by an agent through `swarm config`; audit and one-step revert. | Renaming "Presidium" in one party changes that party's UI only | 404 |
| 406 | plb | Talking to a spawner on its Presidium: a post there is routed by the secretary and answered in the thread. | A message from the UI wakes the spawner under the routing rules and the answer appears in place | 202, 404 |
| 407 | plb | GitHub Issues and Linear adapters, read-only; several sources per repo with precedence; then comments, then state changes, each switched on per repo. | A work item with two sources shows both badges and one state | 114, 401 |
| 408 | plb | Non-code outcomes (D12): declared outcome kinds, evidence, review by the jockey or a named reviewer. | A report ticket completes with a file as proof and no PR | 401 |
| 409 | plb | Mob and sprite status on the board from the mirror; one owner inbox for decisions (imports open items from `mail/bonklek`, `mail/owner`, the port-4170 board). | A dead mob shows stale, never working; each open ask appears once | 107, 404 |

**Gate G4:** bonklek uses the UI for a day in place of the session list; two parties share one repo board without a collision.

### Phase 5. Watching, push, CI, policy

| WP | Owner | Work | Check | Needs |
| --- | --- | --- | --- | --- |
| 501 | plb | Watch service replacing `core-watch.sh`: stall, slowdown, PR log, keep-awake no longer needed on the Studio. 24 h shadow. | Same alerts as the script for 24 h | G2 |
| 502 | plb | Check lock (stays a file lock), check-and-push, retire check, local CI commit status, privacy preflight command. | Parity cases; lock never broken for a live holder | 104 |
| 503 | plb | Exception digest; policy notices from party config changes. | One notice per mailbox per version | 201 |
| 504 | plb | Usage guard at the configured percent and wake at reset, reading the ledger; admission before dispatch. | No dispatch at the stop percent; one wake after reset; a hard budget refuses a launch | 103 |

**Gate G5:** every row of the live dependency table points at Politburo; `core-watch.sh`, `core_mail.sh` and the Tigeryard tooling copies are no longer running.

### Phase 6. Control plane and lifecycle

| WP | Owner | Work | Check | Needs |
| --- | --- | --- | --- | --- |
| 601 | plb | New designs, then builds, for lifecycle stages and evidence gates (replacing held PRs 20 and 21), evidence-released dependencies, history read, "why blocked". | Parity cases for allowed and refused moves; an override records who and why | G4 |
| 602 | plb | Watcher loop, status trust rules, review gate with severity and a reviewer start, Claude cloud launch step, external-action journal, launch recovery without duplicates. | Tigeryard's replay fault cases re-expressed as one seeded test; the pause race does not reproduce | G4 |
| 603 | plb | Refill prompts, resume packets, convergence check, scoreboard on ledger and benchmark records, provider access incidents. | Per matrix rows M36 to M41, M62 | 601 |
| 604 | ty | Parity cases and a seeded Tigeryard board with screenshots of every screen, as reference for 601 to 603. | Delivered before each package starts | — |

**Gate G6:** the parity runner shows no failing or unbuilt row of the first plan's matrix, apart from rows replaced in section 5.

### Phase 7. Scoring

| WP | Owner | Work | Check | Needs |
| --- | --- | --- | --- | --- |
| 701 | plb | Score rules in the party config, outcome records, docks, levels, milestones, leaderboard and scorecard views. | A party that under-reports spend scores lower than one that reports fully; the queue never sorts by score | G4, 103 |

### Phase 8. Migration and wind-down

| WP | Owner | Work | Check | Needs |
| --- | --- | --- | --- | --- |
| 801 | rml, and the decomp board's owner | One-time import of the old Tigeryard boards using the mapping in `work-board-redesign.md` §5: dry run, verify, switch or export-and-stop. The tool lives outside the repo and is deleted after. | Counts and states match the dry run | G4 |
| 802 | ty | Close every open Tigeryard PR with a comment naming the work package that replaced it; retire Tigeryard's mobs; README says where everything went; repo read-only. | No open PR; no live mob | G5, G6 |
| 803 | plb | Delete `packages/swarm/parity/`, the file bridge, and any test that names no failure. | Line count drops; `pnpm check` green | G6 |
| 804 | core | Retire the Tigeryard spawner and its secretary; rename `ty-brief/*` branches to `brief/*`. | — | 802, bonklek's OK |
| 805 | bonklek | After 14 days with no process reading the Tigeryard repo or a copy: archive `bonklek/tigeryard`. | — | 804 |

## 8. Gates, rollback, stop conditions

- **Who judges:** core, from the checks above. HOLD names each failed check. `mg` critiques at the end and answers questions on this plan by mail.
- **Rollback per live cutover:** mail (per tag, under 5 minutes): stop the service for that tag, start `secretary_wake` on the files, which the bridge kept current. Setup: core pastes the previous version. Watch: restart `core-watch.sh`. Each old tool is kept until G5.
- **Stop the merger and mail `mg` and `mail/bonklek`** if: the mail shadow cannot reach a zero diff after two fix rounds; a p0 or p1 is lost because of the board or relay design; a board loses data on restart; a rollback takes longer than promised; swarm PR throughput drops for more than a day because of this work.

## 9. What happens to the freeze and the frozen PRs

The freeze of 2026-11-22 ends with this plan. From now, work is assigned by section 7.

| Item | Disposition |
| --- | --- |
| Tigeryard PRs 59, 60 (board reporting) | Not merged. Input to WP-409. Closed in WP-802. |
| Tigeryard PRs 56, 57 (secretaryd notifier, cutover doc) | Not merged. Superseded by WP-108. No `secretaryd` pilot. |
| Tigeryard PRs 51, 53 (centaur mode) | Not merged. Input to the secretary and Terra design (WP-206). |
| Tigeryard PR 50 (mob scripts) | Not merged. Ported in WP-304. |
| Tigeryard PRs 17 to 23 | Closed in WP-802. |
| Politburo PR 44 (swarm queue and mobs views) | Superseded by WP-404; reuse what fits, then close. |
| Politburo PRs 20, 21 | Stay held; redesigned in WP-601. |
| Politburo `packages/runtime` and `design/swarm-*.md` | Open to change again, as the work packages require. |
| Tigeryard spawner | Builds no new capability in the Tigeryard repo. Its work is WP-104, 105, 106, 208 (review), 604, 802, and p0 or p1 fixes to live tooling. |
| `pi-task`, `sprite-*`, router, setup script | Change only through WP-302 to 305, or a p0 or p1 fix by ty. |

## 10. What needs a person

Work continues around each of these; none stops a phase from starting.

| # | Who | What | Blocks only |
| --- | --- | --- | --- |
| 1 | bonklek | A domain on Cloudflare for the tunnel, and the Access rule "any company email" | WP-113, 111 |
| 2 | bonklek | A TypeSafe API key on the Mac Studio for Jev | WP-205 going beyond a stub |
| 3 | Charlie | Agreement to a read-only view of Remilia World's beads, and how claims are shared with his workers | WP-114 |
| 4 | bonklek | Access for core (or a named person) to install services on the Mac Studio | G1's host check |
| 5 | bonklek | Who owns the decomp research board | WP-801 for that board |
| 6 | bonklek | OK to retire the Tigeryard spawner and to archive its repo | WP-804, 805 |

Core files each as an ask in `mail/bonklek/` and proceeds.

## 11. Tigeryard ideas carried, not code (D10)

| Old item | Idea | Carried into |
| --- | --- | --- |
| QA broker | A QA run tied to an exact candidate, authorized, expiring | WP-601 gates, WP-502 check runner |
| Adapter wrapper | One set of session controls, keeping backend receipts | Runtime harness contract |
| Context packets, source lifecycle | Compact, reproducible context that shows its gaps | WP-108 and 206 case packet; tracker adapters |
| Pre-implementation audit | Find done or overlapping work before paying to do it | WP-107 overlap check |
| Handoff delta | Prove a handoff holds exactly the required change | WP-601 |
| Devin adapter | Recover an uncertain launch without a duplicate | WP-602 |
| Old formats and aliases | Change names without changing authority | Party config labels; cutover readers |
| Scheduler tables, review marks, notification attempts | Separate durable records for attempts, outcomes, deliveries, review timing | WP-103 ledger; wake receipts; human-minutes in scoring |
| Convergence routing, loop boundaries | Wake the right role for a current problem; continue, wait or sleep | WP-108 wake rules |
| Operational outcomes | Prove non-code completion without a fake commit | WP-408 |
| Provider pool, history import, pi setup | Prepare without activating; import history without inventing facts | Model routes in party config; WP-801; onboarding |
| Startup budget, module inventory | Measure reading cost per tier | WP-102 line count; secretary scorecard |
| Service templates, CI, contracts index | Supervise services predictably | WP-112; WP-502 |
| Old storage and migration | Upgrade state without losing meaning | WP-801; tracker mapping |

## 12. Choices made without asking (build on these; `mg` will defend or change them at the critique)

1. A Presidium is a filtered view and a set of party channels on the shared repo board, not a separate process.
2. One party board per party; the first party is bonklek's, with id `default` until he names it.
3. Gates are judged by core, since `mg` is called only at the end.
4. The 4-hour clock runs on the repo board's clock, and the board's ordinary short lease still applies under it.
5. A ticket with no valid outcomes contract is not claimable.
6. Open-claim caps start at 2 per party per repo, 1 uncommitted.
7. Tag renames happen at each tag's mail cutover; old ids stay valid in history; bead ids in Remilia World keep `rw-`.
8. Terra uses `openai-codex/gpt-5.6-terra`; `gpt-6.1-terra` is tested beside it in WP-206.
9. The Tigeryard spawner writes parity cases as PRs to the Politburo repo under `packages/swarm/parity/**` only.
10. Scoring is Phase 7, but party id and outcome records are in every schema from Phase 1.
11. The Jev thresholds in section 4 are placeholders; real values come from shadow data.
12. Cloud mob telemetry is unproven; if WP-111 fails, mob spend is recorded as unknown and the ledger says so.
