status: proposed

# Hill climbs

A hill climb changes one thing to improve one number. Measure the base and
candidate with the same judge. Keep the change if the number improves and
the guard passes. Otherwise revert it. See the keep-or-revert loop in
[Method sources](#method-sources).

The judge lives outside the files a climber can change, in `tools/metrics/`,
and gets separate review. The sibling PR on `mob/184-fox3-metrics-scripts`
adds the first judges; they are not on `main` until it lands.

Areas 5 to 8 (the slower loops) are not yet specified here.

## Readiness

| Rank | Area | Why | What blocks it |
| --- | --- | --- | --- |
| 1 | Fork thinness (3) | Script and measured baseline. Counts repeat at fixed Git refs. | Land the judge. Pin the upstream tip and agree on the file scope for each rung. |
| 2 | Time to first claim (2) | Script and measured baseline. The script exercises a real CLI and board. | Land the judge. Control the machine and store and establish timing noise. |
| 3 | Failing seeds (1) | The simulation design specifies gates, seed shapes and oracles. | No harness in the suite on `main`. Build the driver, check replay and agree on review rules. |
| 4 | Agent cold-start success (4) | The target task exists. | Specify and build the runner and verdict check, then pin the cohort and measure `main`. |

### Common guard

Run `pnpm check` on the candidate. Keep the existing
[conformance tests](../packages/board/test/conformance.test.ts) and their
coverage. No new skips or weaker assertions. For user-visible changes, follow
[AGENTS.md](../AGENTS.md) on docs, changesets and CLI output. For test changes,
[see the test fail for the intended reason](../.claude/skills/test-behavior/SKILL.md)
through a public interface, then restore behavior and see it pass.

A reviewer runs the judge from a trusted checkout against a committed head.
The area 2 and 3 scripts ignore uncommitted changes in the measured repo.
Each rung lists its allowlist. Everything else is read-only, including the
judge, fixture manifests and verdict rules. Keep the machine, budgets and
inputs fixed within a comparison. Judge changes start a new comparison, not
a better score for an old one. See the frozen judge rationale in
[Method sources](#method-sources).

## 1. Failing seeds

### The number

Count distinct reviewed failure signatures found by seeded runs of the local
engine at the evaluated head. Higher is better for the **search**, not for the
product. A signature is a reviewer-assigned ID for one underlying contract
violation. Different seeds, traces, IDs, messages and crash sites do not add
points for the same bug. Count each accepted signature once per batch. See
signature deduplication in [Method sources](#method-sources).

### How it is measured

Proposed command, from the trusted judge checkout (`../candidate` is the
proposed candidate checkout):

```sh
node tools/metrics/failing-seeds.mjs --repo ../candidate --head HEAD --manifest tools/metrics/seed-batch.json
```

The proposed judge, manifest, driver, oracles and review catalog live in
`tools/metrics/`. The manifest pins the engine commit, fixture versions,
seed list and gate budget. `--head` selects the strategy commit, not the
engine. The judge extracts only the proposed search module from that commit
and runs it in a separate process with no engine or judge access. Pass a
fixture operation vocabulary and a per-trial generator seed as JSON. Accept
only a bounded JSON list of operations on fixture aliases. Use a separate
scheduler seed that the strategy never sees. Compare strategies on the same
engine and use the same reviewed catalog on both sides.

- Mount a fresh real engine per seed with `memory()`, `memoryBlob()` and
  the [test issuer](../packages/board/test/tokens.ts). Use distinct verified
  callers with injected JWKS and real token verification. Start without
  scheduler, sync or watchers. Begin with the lease boundary fixture on
  `main`. Do not use evidence, stages or fences from held branches.
- Follow the [simulation design](deterministic-simulation.md): seed
  `mulberry32`, sort parked operations by index, wait for quiescence and
  release one gate at a time. Fake only the wall clock, shared by the engine
  and log. Start at a fixed instant. Select lease boundary clock moves as
  specified there. Record successful appends with time and batch boundaries.
  Merge sessions in landed append order, not by response or log index.
- Run 100 seeds per enabled fixture, with at most 64 operations and 256
  gate visits per seed. Freeze enabled fixtures before each comparison.
  Give each seed a 2-second real-time watchdog and the batch a 5-minute cap
  excluding replay and review. An unexpected stall or exhausted gate budget
  invalidates the batch. Do not score incomplete batches.
- Independent history oracles take only the fixture, landed events and
  public outcomes. Start with I1, live lease, and I2, one claim. Review each
  new witness. Replay twice on fresh engines at the same engine commit with
  the recorded seed, operation list, gate choices, clock moves and faults.
  Require identical normalized histories and outcomes. Save the minimized
  witness, scheduler seed and shrink path if shrunk. Use stable aliases for
  generated IDs and omit tokens. A replay mismatch is a harness failure, not
  a signature. See seed replay in [Method sources](#method-sources).

Output one JSON document. `failures` contains accepted witnesses, one per
signature. `pending` contains unreviewed witness digests, not points. Paths
are relative to the run artifact directory. The judge exits nonzero on an
invalid run and emits `value: null` with a sanitized reason. A valid but
unreviewed result is provisional and cannot win.

```json
{"metric":"failing_seeds","value":1,"unit":"signatures","head":"strategy-sha","engine_head":"engine-sha","manifest":"digest","valid":true,"reason":null,"seeds_run":100,"pending":[],"failures":[{"signature":"review-id","fixture":"lease-boundary","seed":42,"trace":"trace-42.json","digest":"sha256"}]}
```

### The guard

Apply the common guard. The run uses real policy and task writes. Board facts
stay in the board log; table writes, folds and server-authored provenance
follow AGENTS.md. A fix for a discovered bug is separate from the search
climb. Pin a witness that fails before the fix and passes after it. Do not
score a product regression as search progress.

### Baseline on main

Not measured yet. The simulation design is proposed and its earlier
prototype is throwaway code. `main` has no suite harness or reviewed
signature batch. The held-branch counts in the design are not this baseline.

### Gaming risk and the counter

- Split one violation by trace, actor or error text. A reviewer deduplicates
  by contract rule and cause using replayable evidence, not trace hashes.
- Stall cases, inject artificial exceptions or mutate the engine. The judge
  owns the fault list and watchdog, pins the engine head, and rejects
  incomplete runs. Only violations of an independent oracle count.
- Memorize useful seeds. Run the same held-back seed batch for base and
  candidate and release it only after the attempt.

### Levers

Bias operations toward lease boundaries. Use macros to reach ready and
claimed states. Vary callers, conflicts and retries without increasing the
budget. Try varying action weights per run (see swarm sampling in
[Method sources](#method-sources)).

### First three rungs

| Goal | Metric | Done-when | Files | Invariants |
| --- | --- | --- | --- | --- |
| Establish lease replay before climbing | Reviewed count, first baseline | A pinned competing-claim case replays twice. I1 and I2 checks are sensitive to a broken contract. Review the first full batch. | Judge maintainers only: proposed `tools/metrics/` harness and inputs. No climber edits. No board source changes. | Real verified callers; no held-branch features. |
| Exercise renew and release near takeover | More reviewed signatures at fixed budget | A lease-boundary operation list finds an additional signature in the held-back batch. | Proposed `packages/board/test/simulation/search.ts` only. Not the judge, catalog or engine. | Clock moves and lease validity come from the judge, not the search module. |
| Reach waiting and ready states with a finish macro | More reviewed signatures at fixed budget | The judge first pins an I4 fixture and rebaselines both strategies. The macro then finds an additional signature. | Proposed `packages/board/test/simulation/search.ts` only. Not the judge, catalog or engine. | Macro calls do not become atomic. Use only dependency transitions on `main`. |

## 2. Time to first claim

### The number

Elapsed wall seconds, lower is better. Start just before cloning into a
fresh directory. Stop when the script confirms completion of the claimed
task by reading its persisted completion. Report the number of spawned
commands alongside seconds. Count every spawned command once, including Git
ref resolution, checkout, `serve` and history reads; do not count in-process
polling or environment setup. Command count is not a second score.

### How it is measured

Run from a trusted judge checkout (`../candidate` is the proposed candidate
checkout):

```sh
node tools/metrics/time-to-first-claim.mjs --repo ../candidate --head HEAD --timeout 1200
```

Use Linux with `/proc`, Node 22 and the checkout's pnpm version. The
selected head must be reachable in a normal fresh clone. The script clones,
checks out the head, installs with the frozen lockfile and builds
`@vercel/board`. It starts `vb serve --agent-ops` on a disposable loopback
board and waits for its ready banner. The local principal queues the
[local development fixture](../LOCAL-DEVELOPMENT.md). The worker registers,
claims, replies with the candidate and completes. The second identity is a
worker profile under the same principal, not a separate security principal.
The script checks the claim actor, then reads the task's persisted events
with `vb wait` after the reply. It verifies that the completion matches the
task, claim epoch, result and worker identity, and that the completing
profile differs from the creator's.

Cleanup is not timed. The judge gives children an allowlisted environment and
a temporary home. It cleans up process groups and detached descendants that
inherit its run marker. This is cleanup, not a sandbox. Use a trusted
repository and trusted Node startup settings: the judge runs the checkout's
install and build.

Keep the clone source, store policy and machine class fixed. Alternate base
and candidate for five pairs on the same idle runner. Keep a candidate only
if at least four pairs improve and the median paired reduction exceeds the
median absolute deviation of the base runs. Save every run and its phases.

### The guard

Apply the common guard. Each run starts with fresh board storage, an isolated
CLI config and a real frozen install and build. No reuse of build output or
live board state. Require registration, a live worker claim, a landed reply
and completion of that same task. The reviewer checks a fresh board read and
server-authored reply attribution in a separate untimed run of the flow.
Keep CLI exit codes, JSON shape and lease proof handling. A faster ready
banner must still signal a usable board. No secrets in output or artifacts.

### Measured baseline

Measured on 2026-11-22 at `d2a6047` on `mob/184-fox3-metrics-scripts`, on
top of `origin/main` at `45f4d04`. The scripts are not on `main` until
that PR lands. Five full runs on this VM with a warm pnpm store took
16.08 s, 16.13 s, 21.34 s, 18.12 s and 16.10 s. The **median was 16.13 s**
and the **range was 16.08 to 21.34 s**. The script now counts **12 commands**,
including the persisted completion read. The first two runs used an earlier
version that counted 11 commands. These are observations, not timing
thresholds. Install was the largest and noisiest phase; a cold network
install would take longer.

| Phase | Seconds in the 16.10 s run |
| --- | ---: |
| `clone` (including checkout) | 0.47 |
| `install` | 7.51 |
| `build` | 6.13 |
| `serve_ready` | 0.34 |
| `create` | 0.31 |
| `claim` (including registration) | 0.54 |
| `complete` (including reply and persisted history check) | 0.80 |

### Gaming risk and the counter

- Warm only the candidate, or move build work before the clock starts. Use
  a matched store policy and the trusted timer. Delete build and board
  outputs between runs. Report clone, install and build observations.
- Print readiness early, return canned JSON or skip the worker. Keep the
  fixture opaque to the product and verify actual state and attribution over
  the board API. Check other task IDs and profiles in the untimed guard.

### Levers

Install and build dominate the measured run. Look at build duplication,
startup imports and repeated CLI initialization. The fixed script determines
its command count; changing the workflow it times requires separate judge
review and a new baseline.

### First three rungs

| Goal | Metric | Done-when | Files | Invariants |
| --- | --- | --- | --- | --- |
| Remove duplicate build work | Lower seconds, especially `build` | Paired result passes and published entry points and inspector assets still build and load. | `packages/board/tsdown.config.ts` only. Not the judge, lockfile or package exports. | Browser and type boundaries hold. A2 stays bundled. No skipping required artifacts. |
| Reduce no-inspector startup work | Lower seconds, especially `serve_ready` | Paired result passes and both inspector modes still serve correctly. | `packages/board/src/cli/serve.ts` only. Not the judge, policy or routing. | Loopback only for the fixture. Readiness means requests work; `--agent-ops` stays enabled. |
| Defer CLI work unrelated to the selected verb | Lower seconds, including `claim` and `complete` | Paired result passes. Agent and task CLI tests and other command paths stay green. | `packages/board/src/cli/main.ts`, `packages/board/src/cli/hooks.ts`. Not the judge, claim store or server. | CLI calls go through the handle. Preserve exit codes, errors and proof handling. |

## 3. Fork thinness

### The number

Lines added in `packages/board/src` from the merge base with `upstream/main`
to the evaluated head. Lower is better. Count additions, not net growth.
Also report the additions in each of the six hot files and their sum, and
upstream commits not reachable from head. These are diagnostics and guards,
not offsets against the score.

### How it is measured

Run from a trusted judge checkout
(`../candidate` and `../pinned-upstream.git` are proposed checkouts; the latter
has `main` at the reviewer-pinned upstream tip):

```sh
bash tools/metrics/fork-thinness.sh --repo ../candidate --head HEAD --upstream-url ../pinned-upstream.git --upstream-branch main
```

The script fetches upstream in a disposable clone without hardlinking source
objects, finds the merge base and sums Git `--numstat` additions. Renames
within `packages/board/src` count only added lines, attributed to the
destination. A file moved into that scope from elsewhere counts all its
lines. The judge fails if upstream is unreachable, Git skips exhaustive
rename detection or a diff row is binary. Compare recorded `upstream` and
`merge_base` before scoring. An upstream refresh starts a new baseline. For
the baseline below the direct diff check, in the direction that counts fork
additions, is:

```sh
git diff -M -l0 --numstat a65cb8be4c29d86f61f69b6f427d6429b96324cf d2a6047 -- packages/board/src
```

### The guard

Apply the common guard. Keep the same feature behavior, public exports and
capabilities. No hot file gains additions and the candidate does not fall
further behind the pinned upstream tip. Follow the pb-103 hot-file rule:
keep fork code in new files, with one registration line at the relevant
entry point in `serve.ts` or `main.ts`. Keep policy checks before side
effects, CLI calls behind the handle and runtime code out of board. Do not
make a supported capability answer 501 to get conformance to skip it.

### Measured baseline

Measured on 2026-11-22 at `d2a6047` on `mob/184-fox3-metrics-scripts`, on
top of `origin/main` at `45f4d04`. The scripts are not on `main` until
that PR lands. **5,755 lines added in `packages/board/src`**, of which
**2,554** are in the six hot files. The fork is **0 commits behind upstream**.
The `upstream/main` tip is also the merge base, `a65cb8b`. The pnpm store does
not affect Git counts.

| Hot file under `packages/board/src` | Lines added |
| --- | ---: |
| `conformance/index.ts` | 851 |
| `cli/main.ts` | 698 |
| `server/tasks.ts` | 363 |
| `cli/commands.ts` | 280 |
| `api/routes.ts` | 191 |
| `server/serve.ts` | 171 |

### Gaming risk and the counter

- Move implementation out of `packages/board/src` or into generated blobs.
  Enforce the allowlist. Review the full diff and reject scope moves,
  compressed source and generated replacements.
- Delete checks or disable features. Compare the existing case list and
  capability matrix. Require the same assertions, results and skips.
- Pick an upstream ref that counts fewer additions. The reviewer pins and
  records the tip and merge base. No ref substitutions during a comparison.

### Levers

Target actual fork additions: task-authority scenarios in conformance, the
agent command branch in CLI main, and fork-only task dispatch in serve.
Extract and share repeated code. Moving a block inside the tree may lower
hot-file additions but does not by itself lower the headline count.

### First three rungs

| Goal | Metric | Done-when | Files | Invariants |
| --- | --- | --- | --- | --- |
| Separate park, bound-claim and handoff conformance cases from the shared case list | Fewer total additions and fewer in `conformance/index.ts` | Share repeated case setup within the fork cases. The same case names, assertions and capability gates run. A move alone is not a win. | `packages/board/src/conformance/index.ts` and proposed `packages/board/src/conformance/task-authority.ts`. Not the judge, runner or product routes. | Public handle tests, same failures when the behavior breaks, same unsupported backend results. |
| Separate the `agents` subcommands from CLI main | Fewer total additions and fewer in `cli/main.ts` | Extract the fork command with one registration line in main, and remove duplication in option and result handling. | `packages/board/src/cli/main.ts` and proposed `packages/board/src/cli/agent-commands.ts`. Not the judge, CLI specs or server. | Same help, validation and exit codes. No direct HTTP or authority inferred from a role. |
| Separate structured task attention dispatch from serve | Fewer total additions and fewer in `server/serve.ts` | Register a fork handler with one line in serve and share the repeated attention input and dispatch checks without relaxing them. | `packages/board/src/server/serve.ts` and proposed `packages/board/src/server/task-attention-routes.ts`. Not the judge, schemas or policy. | Same verification, middleware and error paths. Keep `no_task_attention` where unsupported and identical task effects where supported. |

## 4. Agent cold-start success

### The number

Successful attempts divided by all scheduled attempts in a valid cohort.
Higher is better. Report the unitless fraction and the numerator and
denominator. An attempt succeeds only if a fresh agent, using the repo docs
without hand-holding, claims the assigned task and completes it correctly.

### How it is measured

Proposed command, from the trusted judge checkout (`../candidate` is the
proposed candidate checkout):

```sh
node tools/metrics/agent-cold-start.mjs --repo ../candidate --head HEAD --manifest tools/metrics/cold-start-batch.json
```

The proposed judge and manifest live in `tools/metrics/`, outside the
agent's mount. The manifest pins the base and candidate refs, exact model
snapshot, runner version, tool set, sampling settings, prompt template and
20 ordered trial seeds. Each seed derives a fresh channel, worker profile
and small wording fixture with a literal expected result. Compare the same
trial IDs and settings and alternate which head runs first. Do not expose
the seed list or expected answers to the agent.

1. Prepare a fresh checkout and isolated config for each attempt. Build the
   CLI and start a fresh loopback board with `--agent-ops`. As the operator,
   queue a ready task and an unrelated distractor. Give the agent only the
   checkout and a task prompt with the assigned task ID, board URL and
   worker profile. Use the repo docs for all procedural guidance. Mount the
   checkout read-only and give the agent tools to read it and invoke the
   built CLI. No history, examples from prior runs or operator correction.
2. Allow at most 5 minutes and 20 tool invocations from prompt delivery. Fix
   the model token cap at 8,000 generated tokens per attempt. No retry,
   fallback, or extra time per attempt. Keep the board store, operator
   control and verdict files out of the tool sandbox. Local profiles share
   a principal; the sandbox, not the profile, isolates the trial.
3. From outside the sandbox, record the public claim and completion events
   and read the thread. Require a live claim by the designated actor,
   a reply by that actor with the fixture's requested literal result and
   completion by that actor on the assigned task. Require an enabled worker
   registration, unchanged task body and no writes to the distractor or
   unrelated resources. The model's final text does not count as evidence.
4. Count timeouts, budget exhaustion and incorrect actions as failures.
   If setup or the provider fails before an attempt can be judged, invalidate
   the whole cohort and rerun it under the same manifest. Do not drop trials.
   Save the prompt, settings, sanitized tool trace and normalized public
   board observations. The same trace and observations must reproduce the
   same verdict offline. Pin fixture generation by seed, but do not promise
   model replay is deterministic. Repeat a winning paired comparison with a
   second held-back cohort before keeping it.

Output one JSON document with per-trial verdicts and artifact digests. For
invalid cohorts set `value` to null, include a sanitized reason and exit
nonzero. `trials` below shows one record, not the whole cohort.

```json
{"metric":"agent_cold_start","value":0.75,"unit":"fraction","head":"sha","manifest":"digest","valid":true,"reason":null,"passed":15,"scheduled":20,"trials":[{"id":"trial-01","pass":false,"reason":"timeout","artifact":"sha256"}]}
```

### The guard

Apply the common guard. Use disposable boards, no real team board or user
credentials, and no raw secrets in prompts or logs. Do not weaken task
claims or authority. Keep the public CLI and its error contract. No fixture
recognition in product code, canned decisions or automated settlement that
substitutes for the agent's work. Preserve the repo's guidance on evidence,
[human gates](swarm-architecture.md#6-human-gates) and publication authority.

### Baseline on main

Not measured yet. No runner executes a pinned fresh-agent cohort and checks
board evidence. The scripted time-to-first-claim runs do not measure an
agent's ability to find or follow the docs.

### Gaming risk and the counter

- Put a solution keyed to the known fixture into the docs or product. Use
  unreleased fixture seeds and distractors. Allow general guidance only.
- Accept “done” from the model or read only the terminal state. Verify
  registration, actor, order, reply content and settlement from board
  observations. Reject collateral writes.
- Retry failures until they pass or choose a stronger model for the
  candidate. Pin the cohort, tool caps and model. Count all attempts and
  invalidate infrastructure failures symmetrically.

### Levers

Find the local walkthrough faster. Make worker identity and CLI setup clear.
Give a useful next step for a recoverable error without scripting the work.

### First three rungs

| Goal | Metric | Done-when | Files | Invariants |
| --- | --- | --- | --- | --- |
| Make the local rehearsal easy to find | Higher success fraction | More assigned tasks pass the board verdict in both paired cohorts. | `README.md`, `LOCAL-DEVELOPMENT.md`. Not the judge, prompts or product. | No fixture-specific solution or real board credentials. |
| Clarify worker profile and claim receipt use | Higher success fraction | More agents keep the same worker identity from registration through settlement and pass both cohorts. | `LOCAL-DEVELOPMENT.md`, `packages/board/docs/01-board/11-tasks.md`, `packages/board/docs/01-board/13-agent-registry.md`. Not the judge or product. | A profile is not a grant. Completion is not approval. |
| Improve recovery from a missing local claim | Higher success fraction | An observable CLI test shows the recovery hint without changing the error contract. Both cohorts improve. | `packages/board/src/cli/main.ts`, `packages/board/test/cli-tasks-claims.test.ts`. Not the judge, claim storage or server. | Advice, not implicit claim or completion. Keep proof and exit semantics. |

## Method sources

### Outside sources

- TigerBeetle [VOPR internals guide](https://raw.githubusercontent.com/tigerbeetle/tigerbeetle/main/docs/internals/vopr.md)
  - **outside source:** VOPR runs production consensus code with simulated
    clock, network and disk to check safety and recovery. A seed drives
    faults such as packet loss, partitions and storage corruption.
  - **outside source:** Replay a failing seed on the same Git commit.
    Assertions and extra simulator checkers detect failures. The guide
    describes accelerated virtual time, not a fixed wall budget per seed.
- TigerBeetle [`vopr.zig`](https://raw.githubusercontent.com/tigerbeetle/tigerbeetle/main/src/vopr.zig)
  - **outside source:** The CLI takes or draws a seed and logs it with the
    run parameters. Default swarm runs vary cluster size, traffic and faults.
    Simulated work and tick limits govern the run, not a fixed elapsed time.
- TigerBeetle [`build.zig`](https://raw.githubusercontent.com/tigerbeetle/tigerbeetle/main/build.zig)
  - **outside source:** The build shows a fixed-seed invocation. Its CI
    definition runs release VOPR separately for the testing and accounting
    state machines, passing the Git commit as the seed argument.
- TigerBeetle [swarm testing blog post](https://tigerbeetle.com/blog/2025-04-23-swarm-testing-data-structures/)
  - **outside source:** Swarm sampling varies feature subsets or action
    weights per run instead of using the same uniform mix. For example,
    equal push and pop probabilities rarely produce large queues.
- TigerBeetle [`ARCHITECTURE.md`](https://raw.githubusercontent.com/tigerbeetle/tigerbeetle/main/docs/ARCHITECTURE.md)
  - **outside source:** A VOPR instance can simulate a whole cluster on one
    thread. The guide describes workload generation and swarm testing in a
    setup with a thousand CPU cores.
- TigerBeetle [2023 blog post](https://tigerbeetle.com/blog/2023-07-11-we-put-a-distributed-database-in-the-browser/)
  - **outside source:** The post reports ten VOPR simulators running around
    the clock. Its example of 3.3 seconds covering 39 simulated minutes
    illustrates time dilation, not a per-seed budget.
- TigerBeetle [historical VOPR Hub README](https://raw.githubusercontent.com/tigerbeetle/tigerbeetle/1f9fd108413f3ac07913614dbbeeceafb512316e/src/vopr_hub/README.md)
  - **outside source:** The Hub accepted opt-in reports with failure type,
    seed and pushed commit, then checked out that commit and replayed in
    Debug to capture logs.
  - **outside source:** It deduplicated correctness and liveness reports
    by type, seed and commit, and crashes by commit and normalized stack
    hash. It could file an issue with the replay inputs and evidence.
- Karpathy's autoresearch [`README.md`](https://raw.githubusercontent.com/karpathy/autoresearch/master/README.md)
  - **outside source:** `train.py` is the only editable experiment file;
    humans maintain `program.md`, while `prepare.py` owns data preparation,
    fixed constants and evaluation. The metric is lower validation bits per
    byte (`val_bpb`), with five minutes of wall-clock training on one GPU,
    excluding startup and compilation. The README cautions against
    comparing across compute platforms.
- Karpathy's autoresearch [`program.md`](https://raw.githubusercontent.com/karpathy/autoresearch/master/program.md)
  - **outside source:** The instructions keep the evaluation harness and
    dependencies fixed. The keep-or-revert loop measures the unchanged
    baseline, commits and runs candidates on a dedicated branch, and logs
    results separately. The numbered loop keeps lower `val_bpb` and resets
    ties or worse scores. The prose allows a near-tie for a meaningful
    simplification.
- OpenAI, [Measuring Goodhart's law](https://openai.com/index/measuring-goodharts-law/)
  - **outside source:** The study optimizes a cheaper reward-model proxy
    for a harder-to-measure objective. Best-of-n picks the largest proxy
    score. In studied settings such as summarization, the true objective
    starts declining past a point in reinforcement-learning optimization.
    This shows proxy overoptimization, not an agent editing its judge.

VOPR fleet scheduling and typical per-seed wall time are not verified.
Whether the VOPR Hub still runs is not verified. Autoresearch's one-file
rule is documented policy, not an enforced boundary.

### Repo inference

- Use a human-owned metric, guard, edit allowlist, budget and baseline for
  each area. The four measures and their budgets are local proposals, not
  results from the outside sources. Local contracts come from
  [SPEC.md](../SPEC.md) and the [work lifecycle](work-lifecycle.md) status.
- Freeze the judge in a trusted checkout and have a trusted runner compute
  the score. Even a frozen judge can reward proxy gains without real gains;
  a writable judge adds the separate risk of changing what is measured.
- Compare candidates against the same judge revision, inputs, budgets and
  worker class. Keep strict improvements only when the guard passes; revert
  ties, regressions and failed runs. Paired comparisons and their thresholds
  are local choices, as are the baselines measured by the sibling scripts.
- Prove replay before scoring failing seeds. Record the commit, seeds,
  fixture, settings and normalized evidence. Replay exact inputs first,
  then shrink and review the witness. Sample action weights at fixed work
  and validate on a judge-owned held-back batch.
- Deduplicate by reviewed contract violation and cause, not by the Hub's
  report keys. Count distinct regression signatures rather than raw failing
  seeds. Missing runs, stalls and replay divergence cannot raise the score.

## Open questions

- Who maintains and reviews the judge inputs and signature catalog?
- Which lease fixtures belong in the first fixed batch on `main`?
- Which runner and store policy are stable enough for timing comparisons?
- When does a useful hot-file extraction justify a separate, unscored change?
- Which model snapshot and tool adapter can stay fixed for both cold-start cohorts?
