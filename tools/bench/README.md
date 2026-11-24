# Benchmark records

Use Node 22 from the repository root. Both commands emit only `bench-run@1`
JSONL to stdout. Supply IDs and short, content-free labels, not transcripts,
paths, or credentials. Check commands are names only; neither tool runs them.

```sh
node tools/bench/sprite-usage.mjs sprite1 --repo acme/web --task t1 > sprite.jsonl
node tools/bench/rollup.mjs --level task --id t1 --repo acme/web \
  --started 2025-01-01T00:00:00Z --ended 2025-01-01T00:00:10Z sprite.jsonl
```

For example, one two-second sprite with one turn and 12 input tokens yields
`turns: 1`, `tokens.in: 12`, `sprites.count: 1` and `sprites.wallSeconds: 2`
in the task record. The task's own `wallSeconds` is 10.

- **Collect:** `--dir` overrides the launcher's default sprites directory.
  Retries count regular session files minus one, or null if there are none.
  Pair `--worktree` with `--base` for tracked Git changes. `--base` must resolve
  to one commit, not a range or option. Use `--outcome blocked --reason CODE`
  for a caller-declared block.
- One record per serving model counts distinct assistant `message_end` turns
  and the tool calls they issue. Records share run timing. Active time excludes
  the union of tool waits and is null if any issued call cannot be timed.
  Thinking uses the model's last valid level, then the last level-change event
  if valid, else null. Without an assistant turn, one record keeps the time,
  outcome, and logged tool-call count, with no model or measured usage.
- Token counts must be nonnegative safe integers. Missing or invalid fields
  are unreported. Cost rounds to micros per turn before summing and is null
  if any counted turn lacks a valid cost.
- **Roll up:** use `--level mob|task|pr|spawner` and one or more JSONL files.
  Repeated run IDs count once. A non-sprite total is skipped if another
  input names it as a parent. Keep other inputs disjoint; a total supplied
  without its children is opaque. `--manifest FILE` writes the contributing
  input IDs keyed by the roll-up ID to a new JSON file. Model slices share
  one physical sprite's time and change counts. A sprite without a model
  contributes to the totals but not to `byModel`. `--mob-session claude`
  downgrades complete coverage to partial; no measured tokens stays none.
  Aggregate active time is unknown without attention data;
  `sprites.activeSeconds` sums the known sprite times.
- Both accept `--parent`, `--task`, `--review-rounds`, `--failed-checks`, and
  `--check pass|fail|not_run` with optional `--check-command NAME` (a name, optionally followed by `check` or `test`; never arguments). A `--reason` is a short code such as `waiting_on_review`, never prose. Roll-ups
  accept `--outcome done|failed|blocked|canceled` with `--reason CODE` as needed.
  A reason code is at most 80 characters, starts with an ASCII letter or
  digit, and otherwise allows letters, digits, spaces, and `_.:-`.
  Provider and model identifiers are at most 128 characters, start with an
  ASCII letter or digit, and otherwise allow letters, digits, and `_.:/-`.
  Thinking levels are at most 32 characters, start with a lowercase ASCII
  letter or digit, and otherwise allow lowercase letters, digits, and `_-`.
  Roll-ups reject malformed identifiers, levels, reason codes, and counts.
- **Exit codes:** `0` success; `2` invalid arguments or input (including a
  missing log); `3` collector only, no exit-code file yet. Errors emit no records.

## Rate before running

Judge five axes from the brief: scope (function to subsystem), components
(files and packages), design decisions (none to a new contract), risk (docs or
tests, internal, user-visible, auth/data/integrity), and novelty (familiar to
unprecedented here). Give one overall score 1–5 and an effort size: S under
about an hour of engineer time, M about a day, L longer. Attach the rating to
an aggregate with `--complexity-score`, `--complexity-size`,
`--complexity-reason` (one line), `--rated-by`, and `--rated-at` (ISO time).
Afterward, compare it against changes, review rounds, failed checks and retries.

## Build a benchmark

Fix a task set with an ID, base commit, brief, golden check outside the agent's
reach, time cap and rating for each task. Run each model and thinking-level pair
at least five times per task, with one sprite in a fresh worktree at the base.
Only the runner pins models. Group by complexity; report pass rate with a Wilson
interval, median and p90 wall seconds and tokens, and tokens per changed line.
Name the source run IDs for every reported number. Use sprite records for
model-grouped reporting.

## Suite runner

```sh
node tools/bench/suite/run.mjs --task serve-responder-flag --rep 1
```

The [suite runner](../../design/benchmark-suite.md) grades a staged snapshot
and leaves separate per-run trees under `--work` for inspection. Results go
in the work root by default, or in a new mode-0700 `--results-dir` outside
those trees. `--out` defaults to `results.jsonl` there. A custom path must have
no `..` and resolve inside the results directory to a new file or a regular,
single-link file, not a symlink. The runner validates before launch and opens
only to append the record after grading.

Exit `0` means a record was written, even for a failing check or a refusal.
Exit `1` means no record was produced; exit `2` means misuse. A refusal records
`not_run` and one of `refused_symlink`, `refused_export` or `refused_encoding`.
The summary includes `skipped_special=N` when export skips special files.
Children get an allowlisted environment and a fresh home. Use `BENCH_PASS_ENV`
to name any additional variables the launcher needs, including model access.
Inherited `GIT_*` variables never cross.

### Threat model and known limits

The runner grades our own sprites. Use one disposable VM per model run. It
is not a sandbox: hostile-sprite escapes such as swapped directories, moved
file descriptors and races against runner files are out of scope. Setup and
the golden command run sprite-written code with the runner's filesystem
permissions. Export stages raw bytes and refuses bases that set
`working-tree-encoding` because they need Git's encoding conversion for
correct churn.
