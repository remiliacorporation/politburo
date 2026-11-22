# Hill-climb judges

**Climbers must not edit this directory, its tests, or its output format.**

Run from the repository root. With no path, each judge uses its own repository.
Success prints one JSON line. Judge failures exit nonzero with no JSON.

## Time to first claim

```bash
node tools/metrics/time-to-first-claim.mjs [checkout]
```

The judge uses `git clone --no-local` to make a disposable copy and checks its
HEAD against the input's committed HEAD before and after setup. It runs
`pnpm install --frozen-lockfile --store-dir <store>` and `pnpm build` in the
clone only. `TTFC_PNPM_STORE_DIR` can name an existing directory separate from
the checkout. Otherwise the store is disposable.

The built CLI runs `vb serve --agent-ops --port 0 --dir <dir> --no-inspect` on
`127.0.0.1`. The judge checks that the spawned server owns the listener before
and after the handoff. The creator creates a task, the worker claims and
completes it, and the creator reads it back. The judge independently checks
the task ID, completed state, and result over HTTP. It falls back to read-only
`local.db` if HTTP is unavailable or returns 401, 403, 405, or 501. A successful
HTTP response that fails verification does not permit a fallback.

- `metric` is `time-to-first-claim`. `seconds` runs from the start of cloning
  through the final listener check. It excludes preflight and cleanup.
- `clone_seconds`, `install_seconds`, and `build_seconds` time their respective
  commands. `board_seconds` runs from server launch through the final check.
- `commands` counts direct spawns from clone start: `git clone`, two clone
  `git rev-parse` HEAD checks, `pnpm install`, `pnpm build`, and five `vb`
  calls. Off Linux it also counts two `lsof` listener checks. That is 10 on
  Linux and 12 elsewhere on success. It excludes preflight Git calls, child
  subprocesses, HTTP and SQLite reads, and cleanup.
- `board_commands` counts only `serve`, `tasks create`, `tasks claim`,
  `tasks complete`, and `read`.
- `head` is the measured commit, `dirty` reports tracked changes in the input,
  and `node` gives the Node version. `task_final_state` is `done`, and
  `verified_by` is `http` or `sqlite`.

Children get `PATH`, disposable home, XDG and temp paths, and judge settings.
Only the pnpm commands also inherit the network allow-list: `HTTP_PROXY`,
`HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` and their lowercase forms;
`SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `CURL_CA_BUNDLE`,
`REQUESTS_CA_BUNDLE`; and `npm_config_cafile`, `npm_config_registry` and their
uppercase forms. The judge does not forward child output.

`TTFC_TIMEOUT_SECONDS` defaults to 300 seconds and includes preflight. Cleanup
has a separate 3-second budget. It kills child process groups and, on Linux,
scans `/proc` for remaining processes with the `TTFC_RUN_ID` marker and kills
them. It removes the disposable directory before printing a score.

## Fork thinness

```bash
bash tools/metrics/fork-thinness.sh [repo-path]
```

The judge uses `refs/remotes/upstream/main` if present. Otherwise it fetches
`main` into a disposable bare repository from `FORK_THINNESS_UPSTREAM` (a local
path or HTTP(S)/file URL), defaulting to `https://github.com/vercel/board`.
It uses the input object store as an alternate and does not update input refs.
Every Git call gets 60 seconds by default, with a 2-second kill grace period.
`FORK_THINNESS_TIMEOUT_SECONDS` overrides the per-call limit in whole seconds.

- `metric` is `fork-thinness`. `added_lines_board_src` counts added lines
  under `packages/board/src` from `merge_base` to `head`. Binary entries and
  gitlinks count as zero. Gitlink type changes under that path fail the judge.
  Renames count at the destination.
- `hot_files` maps six full source paths to their counts and
  `added_lines_hot_files` sums them. Neither changes the headline count.
- `commits_behind_upstream` and `commits_ahead_upstream` count commits unique
  to `upstream` and `head`, respectively. Those fields and `merge_base` are SHAs.

## Known limits

- The second identity is a second profile on one disposable local login.
- Detached-process cleanup is Linux-only. Other POSIX systems use process
  groups only and need `lsof`. Windows is unsupported.
- The install needs registry access with a cold store. Put `pnpm` on `PATH`.
- Fork thinness needs Git 2.43+ and GNU `timeout`. It needs committed SHA-1
  history and exactly one merge base. It rejects shallow input or fetched
  history, partial or promisor input, and missing objects reachable from either
  tip. It ignores uncommitted changes and does not refresh a stale upstream ref.
- Fork thinness isolates global Git config, but input probes and local fetches
  can still read repository config includes outside the temporary home.
