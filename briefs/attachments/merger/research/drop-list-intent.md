# Tigeryard drop list: design intent and fit for Politburo

This evaluates the intent behind D1–D14 in merger plan §4.5, not their current call sites. Source paths below are relative to the Tigeryard export. Tests are cited as design evidence; none were run. Politburo targets are recommendations, not claims that the features already ship.

## D1 — QA broker and `qa_runs` (SUP-43, BRD-10)

- **What it does**  
  `supervisor/qa_broker.py` checks current board authority, the expiring `qa_runs` candidate binding, and the clean registered worktree before spawning an allowlisted check. `git_hardened.py` supplies bounded, read-only Git queries.  
  The broker records intent and result, caps runtime and output, and reconciles stranded runs. It refuses isolation modes it cannot enforce.
- **Why it was built: the intent** — Give QA a narrow execution path without letting a request grant itself authority or pass a check on the wrong revision. The broker’s introduction in `CHANGELOG.md` spells out the authority and isolation checks. `docs/protocol.md` (“QA and small promotions”) says readiness is run-specific and separates passing from promotion. `supervisor/test_qa_broker.py` checks changed HEAD, unsupported isolation, and retaining capacity when a child may still be alive.
- **What rule or idea is worth keeping** — Verify authority and exact inputs at execution time. Bind evidence to what actually ran and distinguish pass, failure, and interruption. Hold the heavy slot until cleanup is proven. A bounded subprocess is not a sandbox; refuse requests whose isolation needs cannot be met.
- **Where that idea could serve Politburo** — Put these checks in the Mac Studio’s exact-head CI and check-and-push paths (M10–M11, M18, M35). Put revision-bound results in the evidence gates and execution/resource observations in the spend ledger. Do not run untrusted candidate code on the office host without an independently enforced boundary.
- **Verdict:** Carry the idea into the shared check runner and evidence gates. Do not port `qa_runs` or a second QA service.
- **Confidence** — High on intent and limits. The broker does not recheck board authority during the child run or prove cleanup of descendants that escape its process group. The isolation needed by each Politburo repo is not established here.

## D2 — Adapter wrapper harness (SUP-07)

- **What it does**  
  `supervisor/harness_adapters.py` maps Pi, Codex CLI and Devin CLI onto local subprocess sessions. It launches against a fixed assignment file using `<task>-a<attempt>` as the operation ID.  
  Terminal collection adds bounded adapter `inspect` output. The wrapper adds neither a usable inbox nor a remote status channel for these adapters.
- **Why it was built: the intent** — Bridge existing adapters into one session lifecycle without rewriting their receipts or board evidence. `docs/harness.md` (“Existing adapters”) and the module docstring describe a thin mapping during the overhaul. `supervisor/test_harness_adapters.py` checks the CLI mapping, rejection of unknown adapters and collection of adapter evidence even when the child failed.
- **What rule or idea is worth keeping** — Standardize lifecycle calls and attempt identity, not the provider’s internal protocol. Preserve native evidence at collection. Advertise messaging or cancellation only at the strength the backend actually supports.
- **Where that idea could serve Politburo** — Use a common session interface and conformance tests (M34) for Pi sprites and cloud mobs, with distinct capabilities. Require Pi for coding. Keep the provider-specific interpretation at the adapter boundary.
- **Verdict:** Carry the idea into Politburo’s harness contract and tests. Drop the transitional wrapper.
- **Confidence** — High. The wrapper shows interface reuse, not that its inbox or watcher registration made the wrapped CLI agents remotely controllable.

## D3 — Context packets and source lifecycle (SUP-30, SUP-31)

- **What it does**  
  `supervisor/context_packets.py` compiles bounded excerpts into a hash-bound manifest with source revisions, snapshots, byte ranges, and coverage gaps. It checks stored packet bytes and assignment binding.  
  `supervisor/source_lifecycle.py` publishes immutable per-principal refresh generations, advances cursors only on publication, and rechecks access at issuance. A freshness bound can withhold stale content.
- **Why it was built: the intent** — Give an assignment a reproducible, auditable slice of source material without treating retrieved text as instructions. Also avoid leaking cached text after revocation or mistaking a partial refresh for current data. The module docstrings and `docs/runtime-contracts.md` (“Source refresh and staleness”) state these rules. `supervisor/test_context_packets.py` checks unknown pagination and forged passage text. `supervisor/test_source_lifecycle.py` checks revocation without refresh, mid-refresh failure, and withholding under a max-age policy.
- **What rule or idea is worth keeping** — Separate evidence, retrieval coverage, and authority. Compile once for the case, with citations and explicit age, truncation, and permission status. Never treat a missing listing entry as deletion without stronger evidence. Do not treat a hash as proof of access or truth.
- **Where that idea could serve Politburo** — Let the secretary assemble a bounded case packet from board events, Git/GitHub, and authorized beads, Linear and GitHub Issues reads. Run deterministic rules first. Send only ambiguous cases to the small classifier and only unresolved cases with a compiled packet to the stateless adviser. Put source cursors and access checks in tracker adapters; keep cached text out of shared digests unless the recipient may see it.
- **Verdict:** Rebuild as a case-packet compiler and source freshness/access contract. Start with direct reads; add retained generations only where a connector needs them.
- **Confidence** — High on design; medium on production fit until connector permissions, pagination, revision identifiers and retention policies are known. The export uses synthetic connectors, not live access tests.

## D4 — Pre-implementation audit (SUP-32)

- **What it does**  
  `supervisor/preimpl_audit.py` validates one read-only disposition against the packet, repository snapshot, linked GitHub records, search coverage and board projection. It produces a targeted revalidation plan when inputs move.  
  `preimpl_audit_io.py` adds bounded local search, write-once report storage and a launch-time check of the saved report’s integrity, base revision and board generation.
- **Why it was built: the intent** — Avoid paying to implement work that already exists or is in progress. The core docstring separates authored, merged, integrated, deployed, verified, accepted and published. `supervisor/test_preimpl_audit.py` rejects title similarity and a merged PR alone as proof of satisfaction; it also rejects a clean conclusion from an incomplete search and checks revalidation when a PR appears.
- **What rule or idea is worth keeping** — Similarity nominates leads; it does not prove equivalence. Cite integrated code at a named revision to support satisfaction and cite actual in-flight work to support overlap. Partial coverage means unresolved, not clear. Refresh affected evidence just before dispatch. An audit is not a closure or approval.
- **Where that idea could serve Politburo** — Put an overlap preflight on each repo board before the spawner spends a slot. Start with exact issue/PR links, open PRs and branches, default-branch code, and current assignments. Include work from people outside the swarm. Use the secretary’s case packet and adviser for ambiguous semantic matches; recheck authoritative Git/GitHub and board state before granting work.
- **Verdict:** Rebuild as overlap detection before dispatch. Do not port the synthetic report checker as the authority.
- **Confidence** — High on intent. The checker verifies reference existence, not semantic correctness or live search provenance. The I/O gate does not rerun validation or itself decide which disposition permits launch. Dispatch and hold thresholds need a Politburo policy.

## D5 — Handoff delta validation (BRD-49)

- **What it does**  
  `board/handoff_delta.py` compares a declared ordered delta and result tree to Git’s candidate, base and target-baseline graph. Prerequisites must be included in order, already reachable, or supported by typed rewrite evidence.  
  It returns a deterministic receipt bound to the exact packet bytes. The consumer rejects changed bytes or an unvalidated receipt. It never integrates or approves.
- **Why it was built: the intent** — Stop a repair or stacked handoff from omitting required work, replaying integrated work, or claiming an unrelated change. `docs/runtime-contracts.md` (“Handoff delta validation”) states the proof rule. `board/test_handoff_delta.py` exercises the repair-only omission, already-reachable prerequisites, a rewritten prerequisite, and mutation after validation.
- **What rule or idea is worth keeping** — An immutable handoff proves what was said, not that it describes the complete change. Compute what remains relative to the intended destination. Require explicit evidence for rewritten prerequisites; do not assume content or behavior is equivalent just because titles match.
- **Where that idea could serve Politburo** — Add a narrow evidence gate to immutable handoffs and check-and-push for stacked or repair work. Use authoritative Git and bind verification to the current candidate, destination baseline, and handoff bytes. Ordinary single-PR work can use exact-head checks without a commit-list packet.
- **Verdict:** Carry the idea into handoff consumption and dependency evidence gates. Do not port the linear-history validator wholesale.
- **Confidence** — High. The old validator rejects ambiguous merge ancestry and only checks externally supplied ownership expectations when provided. Politburo’s policy for squash or merge histories is not established here.

## D6 — Devin CLI adapter (SUP-47)

- **What it does**  
  `adapters/devin.py` runs bounded, noninteractive Devin with a file-bound prompt and operation export. It supports exact-session resume, inspection, idempotent collection and stopping the owned process.  
  Its action journal reconciles an uncertain launch from the saved record, child identity and provider evidence; it does not blindly create a replacement.
- **Why it was built: the intent** — Make a native CLI supervised and recoverable even when a launch may have succeeded but its response was lost. `adapters/README.md` (“Devin CLI adapter” and “External-action journal”) describes the contract. `adapters/test_devin.py` demonstrates recovery of the same session and refusal when the listing is empty or ambiguous.
- **What rule or idea is worth keeping** — Record stable intent before an external side effect. After an uncertain send, adopt only an evidenced match or expose ambiguity; do not pick the newest session or report an operation as never sent.
- **Where that idea could serve Politburo** — Put it in the Pi and mob launch lifecycle and the shared external-action journal (M44). It also fits tracker writes whose acknowledgement can be lost. A direct Devin coding adapter serves nowhere under the Pi-only rule. RemiNET’s separate health integration is outside this verdict.
- **Verdict:** Carry the reconciliation idea into shared external actions. Drop the Devin implementation.
- **Confidence** — High. The code explicitly describes partial provider correlation, not a provider idempotency guarantee. Live provider behavior and the separate health integration were not assessed.

## D7 — Status v1, generic CLI descriptor, and role aliases (SUP-09 subset, SKL-11 subset, BRD-20)

- **What it does**  
  `remote-status.v1.json` describes bounded, sequenced branch status with a candidate and optional dispatch identity echoes; `supervisor/remote_watch.py` reads it alongside v2. `harnesses/default.json` advertises `generic-cli` as headless, not launch-capable.  
  `board/taxonomy.py` maps `spawner`, `sprite` and `mob` to the stored role values and refuses conflicting aliased configuration values.
- **Why it was built: the intent** — Status v1 made remote progress inspectable and orderable without a shared process, and its v2 reader compatibility gave writers a rollout window (`CHANGELOG.md`; `docs/remote-watcher.md`; `test_protocol_v2.py`). `harnesses/README.md` calls generic CLI planned; reserving metadata for a future runtime without implying readiness is inferred. `decisions/0004-core-spawner-mob-sprite.md` and `docs/taxonomy.md` explicitly keep functional roles distinct from the new tier names. `supervisor/test_taxonomy_aliases.py` checks that aliases share the same profile and inbox rather than creating new identities.
- **What rule or idea is worth keeping** — Version remote status, fence it to a registered dispatch and reject old reports. Separate tier, functional role, and execution capability. Normalize compatibility labels at the boundary, and reject conflicting meanings.
- **Where that idea could serve Politburo** — Use the current status schema in the mob watcher (M25/M31), a canonical role/tier split in the agent registry (M46), and capability metadata in onboarding. Read old names or envelopes only for a known cutover source, with a removal condition. No generic launcher is needed.
- **Verdict:** Carry the ideas into status ingestion, the agent registry, and onboarding. Drop the v1 writer and `generic-cli` descriptor; keep only necessary import aliases/readers.
- **Confidence** — High on status and aliases; medium on the placeholder’s original motivation. No generic launch contract or dedicated test was located. Which old wire records require a temporary reader is a cutover question.

## D8 — Attempts, stages, notification attempts, and review marks (BRD-06, BRD-12, BRD-13)

- **What it does**  
  `schema.sql` and `execution_schema.py` preserve attempt reservations with conflict exclusions and review/QA/repair stage records keyed by issue, candidate and stage.  
  `delivery.py` distinguishes a notification attempt from `seen` and terminal receipts. `reviews.py` derives a candidate queue from durable stages and artifacts and records first-seen/reviewed timing separately.
- **Why it was built: the intent** — The scheduler and pipeline entries in `CHANGELOG.md` explain why reservation and dispatch markers had to survive a crash, why stages were revision-bound, and why repair was bounded. The review-queue entry replaces spawner-written reminders with an evidence-backed queue. `board/test_reviews.py` checks that opening/marking a candidate is timing, not acceptance. `board/test_message_redelivery.py` checks that a crash after `seen` does not consume work. The old writers and current retained readers are different things; `reviews.mark` still implements the timing write.
- **What rule or idea is worth keeping** — Reserve before dispatch; do not retry an uncertain launch blindly. Make stage results idempotent and exact-revision. Distinguish notification attempted, acknowledged, and acted on. Distinguish review attention from a qualified verdict, acceptance or publication.
- **Where that idea could serve Politburo** — Use attempt events in the run/spend ledger and admission control, with live-configurable capacity separate from observed costs. Put check/review/repair evidence on the current PR head, not a parallel scheduler. Build the jockey review queue from M73 PR records and capture review latency separately from measured human time. Reuse the secretary mail receipt flow (M58) for delivery semantics.
- **Verdict:** Carry the ideas into the attempt ledger, PR/evidence gates, review queue and mail. Drop the old scheduler tables and notifier as a runtime architecture.
- **Confidence** — High on the four distinctions. The original scheduler is removed in this export, so its former sequencing is supported by the changelog, retained schema and reader tests, not a running scheduler.

## D9 — Convergence action routing and role loop boundaries (BRD-38, BRD-39)

- **What it does**  
  `board/convergence_actions.py` checks goal step, action hash, issue version/head, network generation, wake time, dependencies and recipient before sending one durable, deduplicated request. It does not execute work or route human decisions.  
  `board/loop_boundaries.py` projects role queues and continue/wait/sleep decisions with wake reasons. An evidence-valid handoff can leave a role’s queue without closing the issue globally.
- **Why it was built: the intent** — Routing intent is inferred from the module contract and `board/test_convergence_actions.py`: make a stuck item actionable for its controller without resurrecting an obsolete action after restart or turning a recommendation into a grant. The loop-boundary changelog entry and `board/test_loop_boundaries.py` state the other intent: stop each role churning on correctly handed-off work while preserving global convergence and reopening repair if a gate fails.
- **What rule or idea is worth keeping** — Model “nothing for me to do” separately from “done.” Let precise events wake the right role. Bind any queued remedy to the facts it addresses; deduplication is not a substitute for checking that it is still current when consumed.
- **Where that idea could serve Politburo** — The secretary’s deterministic wake loop can project runnable, waiting, handed-off and stale work by repo and tier, then request a specific action from the owning spawner. Put human decisions in the jockey’s Attention view. Keep M62 convergence read-only and independent of which roles are awake.
- **Verdict:** Rebuild as role-scoped wake rules and current-evidence exception routing. Do not reintroduce a second dispatcher.
- **Confidence** — High on loop intent; medium-high on routing rationale. The route checks an authorization reference, not the authority behind it, and an old message can remain stored as active after a goal step moves. Consumers need a fresh check.

## D10 — Operational outcomes and manifests (BRD-27)

- **What it does**  
  `board/gates.py` binds non-code evidence to a declared outcome ID/version, scope, manifest digest, assignment generation and applicable lease. `evaluate_manifest` checks declared bounded artifacts and a fixed set of local predicates.  
  Completion rechecks the manifest and required gates, including actor separation. Convergence rechecks the manifest identity/digest and gate bindings, not the underlying artifacts or predicates.
- **Why it was built: the intent** — Complete real non-code work without inventing a Git commit or treating a worker’s completion claim as acceptance. `docs/protocol.md` and `board/README.md` document the separate target and review rules. `board/test_operational_outcomes.py` tests valid completion without a head, refusal of missing gates and self-review, and reopening on changed manifest. `board/test_operational_manifest.py` tests changed artifacts and rejection of unknown predicates.
- **What rule or idea is worth keeping** — Declare what must be proven before work starts. Bind evidence and review to that exact outcome version and approved scope. Separate submission, verification and acceptance. A digest proves integrity, not quality; a reviewer label is not an authenticated independent reviewer.
- **Where that idea could serve Politburo** — Add a non-code target to M51 evidence gates. Start with research/report submission using a versioned artifact, sources and an acceptance rubric. For ops work use an authenticated action receipt plus a bounded independent observation of the intended result. Show the proof and any missing review in the jockey view. Use authenticated principals and trusted registration for independence; require live rechecks only where the outcome claims a continuing condition.
- **Verdict:** Rebuild as first-class non-code completion proof. Keep the initial proof types small rather than porting the local predicates and refusal catalog.
- **Confidence** — High. The old actor/steward checks are a tripwire, not an authentication boundary, and convergence does not rerun artifact or predicate checks. Which work needs independent human acceptance versus deterministic verification remains a policy choice.

## D11 — Pi setup, provider preparation, and historical reconciliation (SPR-08, SUP-36 subset, SUP-41)

- **What it does**  
  `setup_pi.py` makes a fresh, paused private instance with planned GUI and Pi role bindings after a metadata readiness check. `provider_pool.py` records candidates and creates eligible configurations as disabled, unqualified routes.  
  `reconcile_history.py` previews legacy evidence, imports idempotently into an attempt ledger with a hashed manifest, and can restore the old ledger if it has not changed since import.
- **Why it was built: the intent** — Separate preparing a usable instance from authorizing execution (`docs/agent-routing.md`; `test_setup_pi.py`). Separate inventory, access, quality evidence and dispatch eligibility (`docs/provider-pool.md`; `test_provider_pool.py`). Preserve benchmarking history without double-counting or inventing zero usage or success (`docs/adoption-checklist.md`; `test_reconcile_history.py`, including corrected completion and rollback).
- **What rule or idea is worth keeping** — Make setup repeatable and activation explicit. Having a provider or model listed does not make it qualified or eligible. Preview migration, preserve provenance and unknowns, and append corrections under stable identities.
- **Where that idea could serve Politburo** — Onboard a repo with a paused board, parent registration, declared trackers, Pi readiness, and live-configurable budgets before approving dispatch. Show route readiness and qualification independently in the provider view. Reuse the historical reconciliation rules for a one-off spend and benchmark import if the owner wants it. Use exact attempt identity, source, and rollup ownership; imported unknowns stay unknown.
- **Verdict:** Carry the ideas into onboarding, route admission and ledger cutover. Do not port the old GUI/CLI instance layout or assume all history is worth importing.
- **Confidence** — High on the separation. Actual source coverage, parser compatibility and which history must move are unknown. The ledger rollback is not a general rollback of board changes or active work.

## D12 — Display stress cases, bounded retrieval, module inventory, and startup reading (UI-32, POL-24–26)

- **What it does**  
  `board/server.py` has opt-in right-to-left and doubled-text display modes. `.contextmink.toml` configures a project profile and discovery exclusions for the optional read-only companion.  
  `tools/module_inventory.py` builds a static reachability/test map; `tools/measure_context.py` estimates routine and conditional reading for each tier and its research variants.
- **Why it was built: the intent** — `CHROME_SCRIPT` explicitly calls the switches visual checks; preventing layout regressions under long labels and reversed flow is inferred. `docs/companion-tools.md` says capped retrieval is not exhaustive and companion reads do not grant mutation authority. `docs/research/module-inventory.md` uses reachability to guide maintenance, not decide removal. `docs/research/startup-context.md` measures the cost of repeated startup instructions and moves detailed reading to named action boundaries. The inventory and measurement tests distinguish references from proof of execution, and shared/conditional files from per-tier routine cost.
- **What rule or idea is worth keeping** — Stress real layouts with awkward inputs. Flag incomplete reads. Keep a single canonical instruction with short startup text and on-demand detail. Compare estimates separately from actual model usage. Static reachability is a clue, not evidence of use or value.
- **Where that idea could serve Politburo** — Use browser fixtures for long colleague titles, narrow jockey/inspector views and right-to-left layout where supported. Put bounded retrieval and coverage in the secretary packet, not a second board interface. Extend `tools/metrics` with TypeScript entrypoint inventory checks where useful and routine-vs-triggered prompt accounting; validate savings against actual Pi and adviser usage.
- **Verdict:** Carry the ideas into inspector tests, secretary retrieval and context-budget metrics. Drop the old query switches and project-specific scripts/configuration.
- **Confidence** — High on the tools and context-budget intent; medium on display motivation beyond the code comment. No dedicated test for the display switches or companion config was found. Discovery exclusions are not access control, and character estimates are not token accounting.

## D13 — macOS services, CI, and runtime-contract index (UI-33, SUP-20, POL-21, BRD-48)

- **What it does**  
  The board LaunchAgent keeps a loopback server up; the watcher LaunchAgent polls on an interval and lets a detached check outlive the poll. `.github/workflows/unittest.yml` runs a bounded, read-only-permission Python unit job on pushes and PRs.  
  `board/contracts.py` validates versioned runtime documents and can index finalized legacy receipts with their source digest and normalized identity/state, without rewriting their bytes.
- **Why it was built: the intent** — `docs/remote-watcher.md` explains the poll/check lifetime separation. Keeping the board independent of a terminal is inferred from its `RunAtLoad`/`KeepAlive` template. The README describes an offline suite used in CI; keeping a repeatable, low-privilege baseline is inferred from the job. `docs/runtime-contracts.md` and `board/test_contracts.py` make the index intent explicit: preserve historical identity and refuse indexing moving or mismatched evidence. The local CI tests also exercise a workflow-command fixture at a pinned head.
- **What rule or idea is worth keeping** — Match supervision to service lifetime. Separate health and restart behavior from worker ownership and cleanup. Make CI checks repeatable and scoped. Normalize old evidence in a separate, versioned view linked to original bytes; unknown versions must not silently become missing records.
- **Where that idea could serve Politburo** — Host the board, watcher and secretary under explicit Mac Studio service definitions with health reporting and ownership of in-flight checks across restarts (M08/M32). Keep `pnpm check` in Politburo CI. Use an immutable receipt projection or source-hash index in cutover if needed, not a new permanent legacy command.
- **Verdict:** Carry the ideas into Mac Studio supervision, TypeScript CI and receipt import. Drop the Python templates and workflow.
- **Confidence** — High on index and watcher semantics; medium on unstated board/CI motivations. No dedicated launchd lifecycle test was found, and reboot or login behavior was not verified.

## D14 — Board storage and migration (BRD-01, with priority mapping in BRD-45)

- **What it does**  
  `board/schema.sql` stores versioned issue state, dependencies, claims, agent and message records, and append-only event history. Fresh boards start paused.  
  `board.py` migrates explicitly by schema version. `board/priority.py` previews and applies the legacy lower-is-more-urgent mapping to a 1–5 scale, preserving the raw value, rule and warning.
- **Why it was built: the intent** — `decisions/0001-judgment-and-execution.md` calls for one task authority, immutable evidence and exact assignment identity; using SQLite to enforce those relationships locally is inferred from the schema. The v15 changelog and `board/test_priority.py` show the migration intent: normalize ordering without losing what the old board meant, and resume safely after a failed migration. `board/test_schema_guard.py` verifies that normal operations refuse incompatible boards instead of upgrading them on open.
- **What rule or idea is worth keeping** — Preserve authority rules and audit lineage, not physical tables. Preview conversions, keep source IDs and raw values, and produce explicit warnings and mapping reasons. Apply conversion idempotently. Priority ranks eligible work; it never creates eligibility or grants authority.
- **Where that idea could serve Politburo** — Keep the append-only board log and build projections for repo and core boards. For an approved import, produce a dry run with counts, unresolved references, and priority decisions before writing provenance-tagged history. Treat beads, Linear, GitHub Issues and board tasks as source-linked records; Git/GitHub remains authoritative for code and PR facts. Do not revive old leases or grants as current dispatch authority.
- **Verdict:** Carry the ideas into log projections, tracker normalization and explicit cutover import if approved. Drop SQLite as the Politburo storage design.
- **Confidence** — High on the migration and mapping intent. The v15 priority step is atomic; older migrations commit stepwise and some DDL runs before the version transaction. Which old records need migration remains open under Q5.

## Summary

| Item | Intent in one line | Verdict | Target in Politburo |
|---|---|---|---|
| D1 | Run bounded, authorized QA on an exact candidate. | Carry the idea | Shared check runner and evidence gates |
| D2 | Unify session controls without losing backend receipts. | Carry the idea | Harness contract and conformance tests |
| D3 | Use compact, reproducible source context without hiding gaps or revocation. | Rebuild as a capability | Secretary case packet and tracker adapters |
| D4 | Find already-integrated or overlapping work before paying to implement it. | Rebuild as a capability | Repo pre-dispatch overlap check |
| D5 | Prove a handoff contains the required delta, without replaying integrated work. | Carry the idea | Handoff and dependency evidence gates |
| D6 | Recover an uncertain launch without creating a duplicate. | Carry the idea | Pi/mob lifecycle and external-action journal |
| D7 | Evolve status, role names and runtime descriptions without changing their authority. | Carry the ideas | Watcher, agent registry and cutover readers |
| D8 | Keep reservation, stage outcome, delivery and review timing distinct and durable. | Carry the ideas | Spend ledger, PR gates, review queue and receipts |
| D9 | Wake the right role for a current remedy without inventing execution authority or global closure. | Rebuild as a capability | Secretary wake rules and exception routing |
| D10 | Prove non-code completion without fabricating a commit. | Rebuild as a capability | Non-code evidence gates and jockey review |
| D11 | Prepare without activating; reconcile history without inventing facts. | Carry the ideas | Onboarding, route admission and ledger cutover |
| D12 | Stress the UI and measure discovery and reading costs without mistaking estimates for truth. | Carry the ideas | Inspector tests, secretary retrieval and metrics |
| D13 | Supervise services predictably and retain verifiable legacy evidence. | Carry the ideas | Mac Studio services, TypeScript CI and receipt import |
| D14 | Upgrade operational state without losing source meaning or changing authority. | Carry the ideas | Board log projections, tracker mapping and cutover |

## Patterns across items

- **Bind proof to the thing it proves (D1, D3–D5, D7–D10).** A check belongs to its candidate; a report belongs to its sources and scope; a remedy belongs to the current issue/goal revision. Never silently carry proof forward to a new target.
- **Separate observation from authority (D1–D4, D6–D11, D14).** A status, wake attempt, receipt, provider readiness flag or review timestamp can inform a decision. None by itself grants dispatch, makes a verdict, or closes work.
- **Make restart safe by design (D1, D3, D6, D8–D9, D11, D13–D14).** Persist identity before a side effect; adopt only what evidence supports. Supersede or append corrections. Do not replay uncertain work as if nothing happened.
- **Keep unknown distinct from false or zero (D3–D4, D6–D7, D10–D14).** Partial reads do not clear overlap; a lost response does not prove no launch; a missing metric is not zero; unreviewed evidence does not establish acceptance.
- **Spend model and human attention only on the exception (D3–D4, D8–D9, D12).** Read a small, current projection first. Use deterministic rules where they suffice. Escalate one evidence-backed case to the next responsible tier only when judgment is needed.
