status: proposed
bonklek decides on this PR

# Benchmarks

## Problem

We cannot compare task time, models or token use by complexity. We also
cannot tell how much of a mob's work we measured.

## Where the data comes from

A sprite started by `pi-task` and `sprite-start` leaves `<name>.jsonl`
and `<name>.rc` under `/tmp/sprites`. The pi log holds one run. A restart
under the same name overwrites it. The `<name>/` session directory survives
restarts. The `.out` file contains final text and is not a measurement source.

| `bench-run@1` field | Source for a sprite |
| --- | --- |
| `schema`, `level` | Collector constants `bench-run@1` and `sprite`. |
| `runId` | Sprite name from the caller. For multiple models, suffix by order of first appearance. |
| `parentId` | Caller's roll-up run ID, or null. |
| `taskId`, `repo` | Caller. A brief ID, board task ID or `owner/repo#n`, and an `owner/name` identifier. |
| `model.provider`, `model.name` | Assistant `message_end.message.provider` and `.model`. `model_change.provider` and `.modelId` describe the router's request, not the serving model. |
| `byModel` | Null on a sprite. |
| `thinking` | Assistant `message_end.message.thinkingLevel`, else the last `thinking_level_change.thinkingLevel`, else null. |
| `startedAt` | `session.timestamp`. |
| `endedAt` | Latest event timestamp in the log, including timestamps on messages. Do not add assistant `durationMs`. |
| `wallSeconds` | Difference between `endedAt` and `startedAt`. |
| `activeSeconds` | Wall time less tool waits, from each `toolResult` message's `timestamp` and `durationMs`. |
| `turns` | Count of distinct assistant `message_end` messages. |
| `toolCalls` | Count of distinct `toolCall` ids in the content of the counted assistant `message_end` messages. Each id matches a `tool_execution_end.toolCallId`, so a split log attributes every call to the model that issued it. |
| `tokens.in`, `tokens.out`, `tokens.reasoning`, `tokens.cached` | Sums of assistant `message_end.message.usage.input`, `.output`, `.reasoning` and `.cacheRead`, respectively. |
| `costMicros` | Assistant `message_end.message.usage.cost.total`, in dollars, converted to integer micros per turn and summed. |
| `outcome.state`, `outcome.reason` | `.rc` and the last assistant `message_end.message.stopReason`, or the caller's explicit blocked override. |
| `changes.files`, `changes.linesAdded`, `changes.linesRemoved` | `git diff --shortstat` against the caller's base ref in the supplied worktree. The watcher prints shortstat, but it is not in the log. Without both inputs, `changes` is null. |
| `reviewRounds` | Caller, or null. |
| `check.result`, `check.command` | Caller supplies `pass`, `fail` or `not_run`, and a check name such as `pnpm check`. Either can be null when unknown. |
| `coverage.tokens` | Derived from which token fields the counted turns report. |
| `complexity.rating.score`, `.size`, `.reason`, `.ratedBy`, `.ratedAt` | Caller passes the brief author's rating, actor ID and time, or null for the whole rating. |
| `complexity.proxies.files`, `.lines`, `.reviewRounds` | `changes.files`, added plus removed lines, and `reviewRounds`. |
| `complexity.proxies.failedChecks`, `.retries` | Failed check count from the caller. Retry proxy from the session file count. |
| `sprites` | Null on a sprite. `count`, `wallSeconds` and `activeSeconds` are roll-up fields. |

The same usage appears in `message_update`, `message_end`, `turn_end`,
`agent_end.messages` and the pi session file. `message_start` can also carry
partial usage. Count each turn once, from assistant `message_end`, by
`message.responseId`. If that ID is missing, use the tuple of provider, model,
timestamp and `usage.totalTokens`. Do not add numbers from the session file.

Claude mob sessions expose no token counts, so their own `tokens` fields
are null. [Harness Usage](../packages/runtime/src/harness.ts) has only cost.

## The bench-run@1 record

One JSON object per line in JSONL. Example:

```json
{
  "schema": "bench-run@1",
  "runId": "sprite-42",
  "level": "sprite",
  "parentId": null,
  "taskId": "pb-106",
  "repo": "acme/web",
  "model": { "provider": "example", "name": "model-a" },
  "byModel": null,
  "thinking": null,
  "startedAt": "2026-01-01T00:00:00.000Z",
  "endedAt": "2026-01-01T00:00:08.000Z",
  "wallSeconds": 8.000,
  "activeSeconds": 6.000,
  "turns": 2,
  "toolCalls": 1,
  "tokens": { "in": 100, "out": 20, "reasoning": null, "cached": 40 },
  "costMicros": null,
  "outcome": { "state": "done", "reason": null },
  "changes": null,
  "reviewRounds": null,
  "check": { "result": null, "command": null },
  "coverage": { "tokens": "partial" },
  "complexity": {
    "rating": {
      "score": 1, "size": "S", "reason": "One small docs change.",
      "ratedBy": "brief-author", "ratedAt": "2025-12-31T23:00:00.000Z"
    },
    "proxies": { "files": null, "lines": null, "reviewRounds": null,
                 "failedChecks": null, "retries": null }
  },
  "sprites": null
}
```

- Unknown is null, never zero. A measured zero is zero. Counts are integers.
  Token fields sum reported values and are null if no counted turn reported
  that field. Coverage is `complete` if every counted turn reported all four
  fields, `none` if none reported any, and `partial` otherwise. Costs are
  `Math.round(usage.cost.total * 1e6)` per turn, summed only if every counted
  turn reported a cost. No counted turns means no reported cost.
- In the sample, `usage.input` excludes cache reads and `totalTokens` equals
  input plus output plus cache reads. Do not add reasoning to output or to
  that total without verifying how pi reports it.
- A sprite record holds one serving model, or null if none is known. A log
  with two models yields two records, `<name>~1` and `<name>~2`, ordered by
  first appearance. Attribute turns, tokens, cost and tool calls only to the
  model whose assistant message issued them. Run-level times, outcome and
  proxies describe the same run on both rows. Use the last reported thinking
  level for the record's model, with the fallback in the source table.
- Times are ISO 8601 UTC with milliseconds. Express elapsed seconds to
  millisecond precision. Without a `.rc`, print nothing and exit 3. The log's
  last timestamp measures the end of logged activity, not the process exit.
- Active seconds are wall seconds less the union of wait intervals. A
  sprite has no human wait. Each tool wait ends at the `toolResult` message
  timestamp and starts `durationMs` earlier. Clip waits to the run bounds
  before taking the union. Do not subtract overlapping waits twice or report
  negative time. If required timing inputs are unknown, report null.
- Exit 0 gives `done`, except when the last assistant `stopReason` is
  `error`, which gives `failed` with reason `model_error`. Exit 124 gives
  `failed` with `timeout`; 125 gives `failed` with `idle`. Exits 130, 137 and
  143 give `canceled` with a null reason. Other codes give `failed` with
  `exit <rc>`. Only the caller can set `blocked` (`--outcome blocked --reason
  ...`). Do not infer it from text.
- Retries are the number of session files for the sprite name minus one.
  Use null if the directory is absent or the count would be negative. This
  is a restart proxy, not the number of agent or provider retries.

## Complexity

The brief's author rates the work before the run. Judge the five axes from
1 to 5 using the brief, then give an overall score from 1 to 5. The overall
score is a judgment, not a formula. Record who rated it and when, and give
one line of reason that names no work content beyond the subject.

| Axis | 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- |
| Scope | One function or equivalent | One module | One feature | Several features | A subsystem |
| Components touched | One file | A few related files | Several modules in one package | Several packages | Cross-cutting across packages |
| Design decisions | None | Local choice | Choose between known approaches | Change a design boundary | Define a new contract |
| Risk class | Docs or tests only | Local internal change | Shared internal behavior | User-visible behavior | Auth, data or integrity |
| Novelty | Done before here | Close local precedent | Adapt a known pattern | Limited precedent | Nothing similar |

Size rates expected effort for a good engineer: S is under about an hour,
M is up to about a day, and L takes longer. Do not revise it using the run's
elapsed time.

Afterward record changed files, churn (added plus removed lines), review
rounds, failed checks and retries. Audit mismatches against the original
rating. A later regression of rating on proxies can show where they agree
or diverge. This design does not fit that regression.

## Roll-up

The levels are `sprite`, `mob`, `task`, `pr` and `spawner`. Sprite records
are leaves. The caller links them to the applicable roll-up with `parentId`.
A roll-up may contain other roll-ups. For a mob, task, PR or spawner, sum
only its distinct descendant sprite leaves, never intermediate totals.

Sum known values separately for each token field, `turns`, `toolCalls` and
`costMicros`. If all leaves lack a field, it stays null. These are sprite
sums, not usage estimates for the mob itself. Token coverage is `none` if
no contributor has token data, `complete` only if all contributors have
complete data, and `partial` otherwise. Include the mob's own session when
judging coverage, even though its tokens do not enter the sum. A Claude mob
with measured sprites therefore has partial coverage.

Set `model` to null on roll-ups. `byModel` is a list of rows with `provider`,
`name`, `turns`, `toolCalls`, `tokens` and `costMicros`. Group the same leaves
by serving `(provider, name)` and use the same sums. Do not invent a model
for unattributed usage. Reports that group by model read only sprite records.

A roll-up's `wallSeconds` is its own elapsed time from its start and end,
not a sum of children. For a mob, subtract the union of human waits from
its wall time when [attention records](../SPEC.md#structured-task-attention)
establish the intervals. Otherwise its `activeSeconds` is null. Other
roll-ups use their own wait intervals if known, not their children's active
seconds. Report the sprite totals separately as `sprites: { count,
wallSeconds, activeSeconds }`. Count each underlying sprite run once for
these totals, even with split model records. Sum known active times; if
none is known, the sum is null.

Two sprites overlap in a 10-second Claude mob. A runs for 8 seconds, 6
active. B runs for 5 seconds, 4 active. The mob has wall 10 and `sprites`
with count 2, wall 13 and active 10. `byModel` keeps A's 40 input and 10
output tokens and B's 20 input and 5 output. The sums are 60 and 15.
Coverage is `partial`. Without attention timing, mob active time is null.

## Where records live on the board

Use a dedicated channel, `bench`. Register the block schema once. Post one
root message per record with text `block('bench-run@1', record)`, post ID
`bench-run:<runId>` and `noSync: true`. Re-ingesting the same record under
that ID is idempotent. Use one trusted writer and check the board-authored
actor on reads, as in the [runtime-attempt@1 scoreboard](../packages/runtime/src/router/scoreboard.ts).
Read valid blocks from live roots and count each run ID once.

A report across tasks reads one channel, paging if needed. A block on each
[task thread](../SPEC.md#tasks) would require enumerating threads and put
measurement into the conversation. Use a board handle. No new API or route.

## Privacy

Keep counts, IDs and times only, with the rubric labels, one-line rating
reason, outcome codes and check names defined above. A blocked reason is a
short caller-supplied code, not copied discussion. Never store prompts,
outputs, transcripts, raw errors, file contents, diffs, paths, tool arguments,
credentials or check output in a record or committed fixture.

## How a benchmark is made

Each task in the fixed set has an ID, base commit, brief, golden check,
time cap and prior rating. Run the golden check outside the agent's reach.
It exits 0 only when the result is right. A sprite exit is not a check pass.

Run every task for each `(model, thinking level)` pair, with at least five
repetitions per cell and the same count in each. Use a fresh worktree at
the base commit and a new sprite name each time. Only the runner pins the model.

For each matrix pair, group results by complexity rating. Compare golden
pass rate with a Wilson interval, median and p90 wall seconds, median and
p90 tokens, and tokens per changed line. Total tokens for a run are
`tokens.in + tokens.out`, null when either is null. Cached tokens are shown
beside it and never added, because cache hits vary by run. Skip
ratios for missing or zero churn. Name the run IDs behind every reported
number. Keep the suite inputs and matrix associated with those IDs so a
comparison can be repeated. See the [suite runner](benchmark-suite.md).

### Threat model and known limits

The runner grades our own sprites. Use one disposable VM per model run. It
is not a sandbox: hostile-sprite escapes such as swapped directories, moved
file descriptors and races against runner files are out of scope. Setup and
the golden command run sprite-written code with the runner's filesystem
permissions. Export stages raw bytes and refuses bases that set
`working-tree-encoding`, because those bases need Git's encoding conversion
for correct churn.

## Open

- Whether `usage.output` includes reasoning is unverified. Reasoning was 0
  in the sample. v1 does not record `cacheWrite`. Costs are the provider's
  list price as pi computed it, not billing.
- The working field list omitted `sprites` but required it in roll-ups. It
  is explicit here, as are spawner roll-ups. Coverage distinguishes all
  missing from partially measured and does not mark a fully measured sum
  partial merely because it is a sum.
- Split rows share physical run timing and proxies. Count that time once in
  sprite totals. Without a serving turn, do not substitute the requested
  model for the unknown serving model.
- The schema requires start and end times. If either is missing, a finished
  log cannot produce a valid record. Do not make up a timestamp. An empty
  session directory cannot yield a negative retry count.
- A restart under the same name overwrites the log and reuses the v1 run ID.
  Replaying a record is not the same as ingesting a new attempt. Use fresh
  names for distinct benchmark runs. v1 cannot recover overwritten usage.

Tigeryard, could `pi-task` and `sprite-start` log the run's `git diff
--numstat` summary (files, added, removed, counts only), an explicit restart
or attempt number, and a machine-readable exit reason? The collector could
then measure these without guessing from Git, session files or exit codes.
