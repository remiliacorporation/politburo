# Judge metrics

**Climbers must not edit anything in `tools/metrics/`.** The judge is outside
what a climber may change. Run it from a trusted copy against the commit being
judged; the scripts ignore uncommitted changes in the measured repository.

## Fork thinness

```sh
tools/metrics/fork-thinness.sh [--repo PATH] [--head REF] [--upstream-url URL_OR_PATH] [--upstream-branch BRANCH]
```

Counts lines added under `packages/board/src` between the merge base and the
selected head, plus additions in six hot files and the number of upstream
commits not reachable from head. Requires Bash, Git, and `timeout`. Defaults:
the repository containing the script, `HEAD`, and `main` at
`https://github.com/vercel/board.git`. Fetches into a disposable clone without
hardlinking source objects. Clone and fetch get 120 seconds each; other Git
commands get 60 seconds each. The overall deadline is 360 seconds. All of
these deadlines escalate to SIGKILL after five seconds. Fetch has its own
process group so a timeout also stops its Git remote helper.

Renames within `packages/board/src` count only added lines, attributed to the
destination. A file moved into that scope from elsewhere counts all its lines.
The metric fails if upstream is unreachable, Git skips exhaustive rename
detection, or a diff row is binary.

```json
{
  "metric": "fork_thinness",
  "value": 7,
  "unit": "lines added in packages/board/src vs merge base with the selected upstream branch",
  "lines_added_src": 7,
  "lines_added_hot": 3,
  "hot_files": {
    "packages/board/src/conformance/index.ts": 1,
    "packages/board/src/cli/main.ts": 2,
    "packages/board/src/server/tasks.ts": 0,
    "packages/board/src/cli/commands.ts": 0,
    "packages/board/src/api/routes.ts": 0,
    "packages/board/src/server/serve.ts": 0
  },
  "commits_behind_upstream": 2,
  "head": "<sha>",
  "merge_base": "<sha>",
  "upstream": "<sha>"
}
```

## Time to first claim

```sh
node tools/metrics/time-to-first-claim.mjs [--repo PATH_OR_URL] [--head REF] [--timeout SECONDS]
```

Times the fresh clone, frozen install, board build, and handoff on a disposable
loopback board with `--agent-ops`. The local principal queues the fixture. The
registered `demo-worker` profile claims it, replies with the candidate, and
completes it. These are distinct board identities under one local principal,
not separate security principals. `claim` includes registration; `complete`
includes the reply and the persisted history check. After completion, the judge
uses `vb wait --re <task-id> --after <reply-id> --json` to read the task's events
and check that the completion matches the task, claim epoch, result, and worker
identity. Every spawned command counts once, including Git ref resolution,
checkout, `serve`, and history reads. Cleanup is not timed.

Requires Linux with `/proc`, Node 22, Git, and the checkout's pnpm version.
Defaults: the repository containing the script, `HEAD`, and a 1200-second
deadline. The head must be available in a normal fresh clone (for example a
branch, tag, or reachable SHA). Network speed, dependency availability, and
machine load affect timings. Use a trusted repository: this metric runs its
dependency install and build.

The judge starts children with an allowlisted environment and a temporary home.
It kills child process groups, then uses a per-run marker in `/proc` to kill and
verify removal of detached descendants that inherited the marker. This is cleanup,
not a sandbox. Node's own diagnostics and startup hooks are outside the script's
control. A child that starts a new session (for example with `setsid`) and
clears its environment escapes both cleanup methods. Run Node with trusted
startup settings; the judge refuses to run if `NODE_DEBUG` is non-empty.

```json
{
  "metric": "time_to_first_claim",
  "value": 14.5,
  "unit": "seconds from fresh clone to second identity completing a claimed task",
  "seconds": 14.5,
  "commands": 12,
  "phases": {
    "clone": 0.5,
    "install": 7.3,
    "build": 5.5,
    "serve_ready": 0.3,
    "create": 0.2,
    "claim": 0.3,
    "complete": 0.4
  },
  "head": "<sha>"
}
```

## Exit codes and tests

Both scripts exit `0` with exactly one JSON document on stdout, or `1` with
empty stdout and one `error: <reason>` line on stderr. The judge never replays
raw child logs.

Run `pnpm test:metrics` from the repository root. This suite is separate from
`pnpm check`. The offline real-board tests reuse the
built `packages/board/dist/cli.mjs` and skip if it is missing.

## Swarm lines

```sh
tools/metrics/swarm-lines.sh [--repo PATH] [--head REF]
```

Counts newline-terminated lines in committed `.ts` files under
`packages/swarm/src` and `packages/swarm/test`, including subdirectories.
`value` equals `lines_src`; `lines_test` is separate. A head without swarm
files reports zero. Requires Bash and Git. Defaults: the repository containing
the script and `HEAD`. No network or upstream is needed. The same exit codes
apply.

```json
{"metric":"swarm_lines","value":7,"unit":"lines of TypeScript in packages/swarm/src (tests counted separately)","lines_src":7,"lines_test":3,"head":"<sha>"}
```

Run its test with `node --test tools/metrics/test/swarm-lines.test.mjs`.
