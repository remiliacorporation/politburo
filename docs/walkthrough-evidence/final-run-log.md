# WP-904 final check

The doc first clones main from GitHub; this sandbox substitutes a local clone of the branch.

```bash
RUN=$(mktemp -d)/politburo && git clone -q /home/user/politburo "$RUN" && git -C "$RUN" checkout -q claude/keen-einstein-2gru36 && git -C "$RUN" rev-parse --short HEAD && git -C "$RUN" status --short
```

```text
c4be993
exit 0; 1s
$ whoami
root
$ id -u
0
```

The substituted checkout is the working directory (replacing `cd politburo`). `2753492` is an ancestor of `c4be993`.

```bash
node --version
```

```text
v22.23.5

exit 0; 5ms
```

```bash
pnpm --version
```

```text
11.23.0

exit 0; 674ms
```

```bash
git --version
```

```text
git version 2.43.0

exit 0; 4ms
```

```bash
pnpm install
```

```text
Lockfile is up to date, resolution step is skipped
Progress: resolved 1, reused 0, downloaded 0, added 0
Packages: +458
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Packages are hard linked from the content-addressable store to the virtual store.
  Content-addressable store is at: /root/.local/share/pnpm/store/v11
  Virtual store is at:             node_modules/.pnpm
Progress: resolved 458, reused 458, downloaded 0, added 458, done
[WARN] Failed to create bin at /tmp/tmp.EHOlx5dIvg/politburo/apps/preview-publisher/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.EHOlx5dIvg/politburo/packages/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.EHOlx5dIvg/politburo/apps/preview-publisher/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.EHOlx5dIvg/politburo/packages/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.EHOlx5dIvg/politburo/packages/runtime/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.EHOlx5dIvg/politburo/packages/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.EHOlx5dIvg/politburo/packages/runtime/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.EHOlx5dIvg/politburo/packages/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.EHOlx5dIvg/politburo/packages/swarm/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.EHOlx5dIvg/politburo/packages/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.EHOlx5dIvg/politburo/packages/swarm/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.EHOlx5dIvg/politburo/packages/board/dist/cli.mjs'

devDependencies:
+ @changesets/cli 3.0.3

[WARN] Failed to create bin at /tmp/tmp.EHOlx5dIvg/politburo/apps/preview-publisher/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.EHOlx5dIvg/politburo/apps/preview-publisher/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.EHOlx5dIvg/politburo/apps/preview-publisher/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.EHOlx5dIvg/politburo/apps/preview-publisher/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.EHOlx5dIvg/politburo/packages/runtime/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.EHOlx5dIvg/politburo/packages/runtime/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.EHOlx5dIvg/politburo/packages/runtime/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.EHOlx5dIvg/politburo/packages/runtime/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.EHOlx5dIvg/politburo/packages/swarm/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.EHOlx5dIvg/politburo/packages/swarm/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.EHOlx5dIvg/politburo/packages/swarm/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.EHOlx5dIvg/politburo/packages/swarm/node_modules/@vercel/board/dist/cli.mjs'
Done in 1.2s using pnpm v11.23.0

exit 0; 1476ms
```

```bash
pnpm --filter @remilia/politburo-swarm... build
```

```text
packages/board build: ℹ dist/client-BoYfh6TE.d.mts                 34.43 kB │ gzip:  10.72 kB
packages/board build: ℹ dist/provider-BjluY5SU.d.mts               26.09 kB │ gzip:   6.07 kB
packages/board build: ℹ dist/commands-AfH8iSin.d.mts               21.86 kB │ gzip:   4.71 kB
packages/board build: ℹ dist/auth-Dr9x5ZP-.d.mts                   11.30 kB │ gzip:   3.99 kB
packages/board build: ℹ dist/chat-provider-Cmsy2RfE.d.mts           7.36 kB │ gzip:   2.25 kB
packages/board build: ℹ dist/exports-BNWHSK25.d.mts                 2.36 kB │ gzip:   1.11 kB
packages/board build: ℹ dist/blocks-DGvh2alZ.d.mts                  1.56 kB │ gzip:   0.75 kB
packages/board build: ℹ dist/index-3CfMvXdw.d.mts                   0.50 kB │ gzip:   0.34 kB
packages/board build: ℹ 86 files, total: 2.42 MB
packages/board build: ✔ Build complete in 4524ms
packages/board build: [33m[PLUGIN_TIMINGS] [0mJavaScript callbacks ran for 4.4s of this 4.5s build (99%).
packages/board build: The slowest callbacks, timed inside each callback (the wait before a callback starts is excluded, the time it awaits is included):
packages/board build:   - plugin rolldown-plugin-dts:generate buildStart (71%, 3.2s, 1 call)
packages/board build: Additional callback time came from the callbacks below and from callbacks under 1s.
packages/board build: 4 callbacks are listed without a time. Their calls overlapped, so the time inside one call includes work from other calls. To find their cost, profile the build with `node --cpu-prof`:
packages/board build:   - plugin rolldown-plugin-dts:resolver resolveId (566 calls)
packages/board build:   - plugin tsdown:deps resolveId (302 calls)
packages/board build:   - plugin rolldown-plugin-dts:generate load (66 calls)
packages/board build:   … and 1 more
packages/board build: See https://rolldown.rs/reference/InputOptions.checks#bundlertimings for more details.
packages/board build: Done
packages/runtime build$ tsc -p tsconfig.build.json
packages/runtime build: Done
packages/swarm build$ tsc -p tsconfig.build.json
packages/swarm build: Done

exit 0; 5965ms
```

```bash
umask 077
```

```text

exit 0; 1ms
```

```bash
demo_dir=$(mktemp -d /tmp/politburo.XXXXXX)
```

```text

exit 0; 4ms
```

```bash
printf '%s\n' "$demo_dir"
```

```text
/tmp/politburo.zwkObY

exit 0; 2ms
```

```bash
XDG_CONFIG_HOME="${demo_dir:?}/config" node packages/board/dist/cli.mjs serve --swarm --port 0 --dir "$demo_dir/data" --no-inspect
```

```text
serving a local board at http://127.0.0.1:43621/api/board as local:user:root, its log in /tmp/politburo.zwkObY/data  (Ctrl-C to stop)
reach it with --url http://127.0.0.1:43621/api/board, or BOARD_URL=http://127.0.0.1:43621/api/board

exit 0 (ready; final exit recorded at shutdown); 327ms
```

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text

exit 0; 2ms
```

```bash
cat > "${demo_dir:?}/party.yaml" <<'YAML'
party:
  id: local-demo
  name: Local Demo
  colour: '#356a8a'
YAML
```

```text

exit 0; 3ms
```

```bash
node packages/swarm/dist/cli.js config validate --party "$demo_dir/party.yaml"
```

```text
valid

exit 0; 186ms
```

The `read -r -p` commands use here-strings; Bash does not print the prompts with non-terminal input.

### Second terminal

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text

exit 0; 2ms
```

```bash
read -r -p 'Board API URL: ' board_url
```

```text

exit 0; 1ms
```

```bash
unset BOARD_NAME BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR
```

```text

exit 0; 2ms
```

```bash
export XDG_CONFIG_HOME="${demo_dir:?}/config"
```

```text

exit 0; 2ms
```

```bash
vb() { node packages/board/dist/cli.mjs --url "${board_url:?}" "$@"; }
```

```text

exit 0; 1ms
```

### Third terminal

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text

exit 0; 2ms
```

```bash
read -r -p 'Board API URL: ' board_url
```

```text

exit 0; 2ms
```

```bash
unset BOARD_NAME BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR
```

```text

exit 0; 2ms
```

```bash
export XDG_CONFIG_HOME="${demo_dir:?}/config"
```

```text

exit 0; 1ms
```

```bash
vb() { node packages/board/dist/cli.mjs --url "${board_url:?}" "$@"; }
```

```text

exit 0; 2ms
```

```bash
vb inspect --port 0 --no-open
```

```text
inspecting http://127.0.0.1:43621/api/board as root at http://127.0.0.1:34385  (Ctrl-C to stop)

exit 0 (ready; final exit recorded at shutdown); 269ms
```

### Task loop and browser evidence

```bash
vb tasks create work/acme/web 'Confirm the local work board' --no-sync
```

```text
2

exit 0; 239ms
```

```bash
node /tmp/wp904/browser.cjs "$inspector_url"
```

```text
Opened Work (539ms)
Error: ENOENT: no such file or directory, open '/tmp/wp904/live-task-id'
    at readFileSync (node:fs:440:20)
    at /tmp/wp904/browser.cjs:17:20 {
  errno: -2,
  code: 'ENOENT',
  syscall: 'open',
  path: '/tmp/wp904/live-task-id'
}

exit 1; 12849ms
```

Browser artifacts: `01-ready.png` (Ready to pull), `02-running.png` (Running now), `03-left-work.png` (task gone from Work), `04-completed.png` (completed task and result). Only successful assertions produce their screenshot.

```bash
pnpm --filter @remilia/politburo-swarm test
```

```text
  ---
  duration_ms: 53.272173
  type: 'test'
  ...
# Subtest: repeated ref-read failures must lengthen the retry interval
ok 412 - repeated ref-read failures must lengthen the retry interval
  ---
  duration_ms: 0.37591
  type: 'test'
  ...
# Subtest: stale commits and contradictory or unknown review levels cannot grant a verdict
ok 413 - stale commits and contradictory or unknown review levels cannot grant a verdict
  ---
  duration_ms: 0.223566
  type: 'test'
  ...
1..413
# tests 437
# suites 1
# pass 436
# fail 0
# cancelled 0
# skipped 1
# todo 0
# duration_ms 35050.893027

exit 0; 35746ms
```

```bash
kill -TERM 4996; wait 4996 # inspector handles SIGTERM like Ctrl+C
```

```text
inspecting http://127.0.0.1:43621/api/board as root at http://127.0.0.1:34385  (Ctrl-C to stop)

exit 0; 8ms
```

```bash
kill -TERM 4930; wait 4930 # board handles SIGTERM like Ctrl+C
```

```text
serving a local board at http://127.0.0.1:43621/api/board as local:user:root, its log in /tmp/politburo.zwkObY/data  (Ctrl-C to stop)
reach it with --url http://127.0.0.1:43621/api/board, or BOARD_URL=http://127.0.0.1:43621/api/board

exit 0; 12ms
```

```bash
rm -rf -- "${demo_dir:?}"
```

```text

exit 0; 7ms
```

## Walkthrough retry: corrected only the verification harness

The CLI printed a bare numeric task ID. The first browser attempt failed because the harness expected a leading #; the doc correctly asks to copy the printed ID. Repeating on a new temporary board in the same checkout.

```bash
umask 077
```

```text

exit 0; 2ms
```

```bash
demo_dir=$(mktemp -d /tmp/politburo.XXXXXX)
```

```text

exit 0; 3ms
```

```bash
printf '%s\n' "$demo_dir"
```

```text
/tmp/politburo.w6xnwF

exit 0; 2ms
```

```bash
XDG_CONFIG_HOME="${demo_dir:?}/config" node packages/board/dist/cli.mjs serve --swarm --port 0 --dir "$demo_dir/data" --no-inspect
```

```text
serving a local board at http://127.0.0.1:46487/api/board as local:user:root, its log in /tmp/politburo.w6xnwF/data  (Ctrl-C to stop)
reach it with --url http://127.0.0.1:46487/api/board, or BOARD_URL=http://127.0.0.1:46487/api/board

exit 0 (ready; final exit recorded at shutdown); 322ms
```

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text

exit 0; 2ms
```

```bash
cat > "${demo_dir:?}/party.yaml" <<'YAML'
party:
  id: local-demo
  name: Local Demo
  colour: '#356a8a'
YAML
```

```text

exit 0; 3ms
```

```bash
node packages/swarm/dist/cli.js config validate --party "$demo_dir/party.yaml"
```

```text
valid

exit 0; 182ms
```

The `read -r -p` commands use here-strings; Bash does not print the prompts with non-terminal input.

### Second terminal

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text

exit 0; 2ms
```

```bash
read -r -p 'Board API URL: ' board_url
```

```text

exit 0; 2ms
```

```bash
unset BOARD_NAME BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR
```

```text

exit 0; 1ms
```

```bash
export XDG_CONFIG_HOME="${demo_dir:?}/config"
```

```text

exit 0; 2ms
```

```bash
vb() { node packages/board/dist/cli.mjs --url "${board_url:?}" "$@"; }
```

```text

exit 0; 1ms
```

### Third terminal

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text

exit 0; 2ms
```

```bash
read -r -p 'Board API URL: ' board_url
```

```text

exit 0; 2ms
```

```bash
unset BOARD_NAME BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR
```

```text

exit 0; 1ms
```

```bash
export XDG_CONFIG_HOME="${demo_dir:?}/config"
```

```text

exit 0; 2ms
```

```bash
vb() { node packages/board/dist/cli.mjs --url "${board_url:?}" "$@"; }
```

```text

exit 0; 2ms
```

```bash
vb inspect --port 0 --no-open
```

```text
inspecting http://127.0.0.1:46487/api/board as root at http://127.0.0.1:45501  (Ctrl-C to stop)

exit 0 (ready; final exit recorded at shutdown); 268ms
```

### Task loop and browser evidence

```bash
vb tasks create work/acme/web 'Confirm the local work board' --no-sync
```

```text
2

exit 0; 262ms
```

```bash
read -r -p 'Task ID: ' task_id
```

```text

exit 0; 2ms
```

```bash
vb tasks claim "${task_id:?}" --lease 15m
```

```text
#2  yours for 15m  Confirm the local work board

exit 0; 243ms
```

```bash
vb tasks complete "${task_id:?}" 'UI verified'
```

```text
completed 2

exit 0; 249ms
```

```bash
node /tmp/wp904/browser.cjs "$inspector_url"
```

```text
Opened Work (391ms)
Ready to pull: Confirm the local work board (904ms)
Running now: Confirm the local work board (1755ms)
locator.waitFor: Error: strict mode violation: getByText('Confirm the local work board', { exact: true }) resolved to 2 elements:
    1) <a href="/work?thread=2">Confirm the local work board</a> aka locator('#work-running').getByRole('link', { name: 'Confirm the local work board' })
    2) <a href="/work?thread=2">Confirm the local work board</a> aka getByRole('link', { name: 'Confirm the local work board' }).nth(1)

Call log:
[2m  - waiting for getByText('Confirm the local work board', { exact: true }) to be detached[22m

    at /tmp/wp904/browser.cjs:30:50 {
  log: [
    "  - waiting for getByText('Confirm the local work board', { exact: true }) to be detached"
  ]
}

exit 1; 2218ms
```

Browser artifacts: `01-ready.png` (Ready to pull), `02-running.png` (Running now), `03-left-work.png` (task gone from Work), `04-completed.png` (completed task and result). Only successful assertions produce their screenshot.

```bash
pnpm --filter @remilia/politburo-swarm test
```

```text
  ---
  duration_ms: 76.004302
  type: 'test'
  ...
# Subtest: repeated ref-read failures must lengthen the retry interval
ok 412 - repeated ref-read failures must lengthen the retry interval
  ---
  duration_ms: 0.42645
  type: 'test'
  ...
# Subtest: stale commits and contradictory or unknown review levels cannot grant a verdict
ok 413 - stale commits and contradictory or unknown review levels cannot grant a verdict
  ---
  duration_ms: 0.218209
  type: 'test'
  ...
1..413
# tests 437
# suites 1
# pass 436
# fail 0
# cancelled 0
# skipped 1
# todo 0
# duration_ms 35171.488936

exit 0; 35950ms
```

```bash
kill -TERM 8922; wait 8922 # inspector handles SIGTERM like Ctrl+C
```

```text
inspecting http://127.0.0.1:46487/api/board as root at http://127.0.0.1:45501  (Ctrl-C to stop)

exit 0; 9ms
```

```bash
kill -TERM 8856; wait 8856 # board handles SIGTERM like Ctrl+C
```

```text
serving a local board at http://127.0.0.1:46487/api/board as local:user:root, its log in /tmp/politburo.w6xnwF/data  (Ctrl-C to stop)
reach it with --url http://127.0.0.1:46487/api/board, or BOARD_URL=http://127.0.0.1:46487/api/board

exit 0; 17ms
```

```bash
rm -rf -- "${demo_dir:?}"
```

```text

exit 0; 6ms
```

## Final walkthrough attempt

The second Playwright attempt reached Running, then its single-element locator failed because Work renders the same task twice. The final harness waits for zero matches. No walkthrough instructions changed.

```bash
umask 077
```

```text

exit 0; 2ms
```

```bash
demo_dir=$(mktemp -d /tmp/politburo.XXXXXX)
```

```text

exit 0; 3ms
```

```bash
printf '%s\n' "$demo_dir"
```

```text
/tmp/politburo.QIaTnc

exit 0; 2ms
```

```bash
XDG_CONFIG_HOME="${demo_dir:?}/config" node packages/board/dist/cli.mjs serve --swarm --port 0 --dir "$demo_dir/data" --no-inspect
```

```text
serving a local board at http://127.0.0.1:43739/api/board as local:user:root, its log in /tmp/politburo.QIaTnc/data  (Ctrl-C to stop)
reach it with --url http://127.0.0.1:43739/api/board, or BOARD_URL=http://127.0.0.1:43739/api/board

exit 0 (ready; final exit recorded at shutdown); 273ms
```

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text

exit 0; 3ms
```

```bash
cat > "${demo_dir:?}/party.yaml" <<'YAML'
party:
  id: local-demo
  name: Local Demo
  colour: '#356a8a'
YAML
```

```text

exit 0; 3ms
```

```bash
node packages/swarm/dist/cli.js config validate --party "$demo_dir/party.yaml"
```

```text
valid

exit 0; 159ms
```

The `read -r -p` commands use here-strings; Bash does not print the prompts with non-terminal input.

### Second terminal

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text

exit 0; 2ms
```

```bash
read -r -p 'Board API URL: ' board_url
```

```text

exit 0; 1ms
```

```bash
unset BOARD_NAME BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR
```

```text

exit 0; 2ms
```

```bash
export XDG_CONFIG_HOME="${demo_dir:?}/config"
```

```text

exit 0; 2ms
```

```bash
vb() { node packages/board/dist/cli.mjs --url "${board_url:?}" "$@"; }
```

```text

exit 0; 1ms
```

### Third terminal

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text

exit 0; 2ms
```

```bash
read -r -p 'Board API URL: ' board_url
```

```text

exit 0; 1ms
```

```bash
unset BOARD_NAME BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR
```

```text

exit 0; 2ms
```

```bash
export XDG_CONFIG_HOME="${demo_dir:?}/config"
```

```text

exit 0; 1ms
```

```bash
vb() { node packages/board/dist/cli.mjs --url "${board_url:?}" "$@"; }
```

```text

exit 0; 2ms
```

```bash
vb inspect --port 0 --no-open
```

```text
inspecting http://127.0.0.1:43739/api/board as root at http://127.0.0.1:37263  (Ctrl-C to stop)

exit 0 (ready; final exit recorded at shutdown); 269ms
```

### Task loop and browser evidence

```bash
vb tasks create work/acme/web 'Confirm the local work board' --no-sync
```

```text
2

exit 0; 304ms
```

```bash
read -r -p 'Task ID: ' task_id
```

```text

exit 0; 2ms
```

```bash
vb tasks claim "${task_id:?}" --lease 15m
```

```text
#2  yours for 15m  Confirm the local work board

exit 0; 228ms
```

```bash
vb tasks complete "${task_id:?}" 'UI verified'
```

```text
completed 2

exit 0; 223ms
```

```bash
node /tmp/wp904/browser.cjs "$inspector_url" "$demo_dir/task-id"
```

```text
Opened Work (398ms)
Ready to pull: Confirm the local work board (877ms)
Running now: Confirm the local work board (1241ms)
Work: Confirm the local work board left the view (1573ms)
Completed: completed #2 Confirm the local work board UI verified #work/acme/web now (1758ms)

exit 0; 1988ms
```

Browser artifacts: `01-ready.png` (Ready to pull), `02-running.png` (Running now), `03-left-work.png` (task gone from Work), `04-completed.png` (completed task and result). Only successful assertions produce their screenshot.

```bash
pnpm --filter @remilia/politburo-swarm test
```

```text
  ---
  duration_ms: 95.221414
  type: 'test'
  ...
# Subtest: repeated ref-read failures must lengthen the retry interval
ok 412 - repeated ref-read failures must lengthen the retry interval
  ---
  duration_ms: 0.392088
  type: 'test'
  ...
# Subtest: stale commits and contradictory or unknown review levels cannot grant a verdict
ok 413 - stale commits and contradictory or unknown review levels cannot grant a verdict
  ---
  duration_ms: 0.205187
  type: 'test'
  ...
1..413
# tests 437
# suites 1
# pass 436
# fail 0
# cancelled 0
# skipped 1
# todo 0
# duration_ms 34729.383684

exit 0; 35442ms
```

```bash
kill -TERM 12942; wait 12942 # inspector handles SIGTERM like Ctrl+C
```

```text
inspecting http://127.0.0.1:43739/api/board as root at http://127.0.0.1:37263  (Ctrl-C to stop)

exit 0; 7ms
```

```bash
kill -TERM 12878; wait 12878 # board handles SIGTERM like Ctrl+C
```

```text
serving a local board at http://127.0.0.1:43739/api/board as local:user:root, its log in /tmp/politburo.QIaTnc/data  (Ctrl-C to stop)
reach it with --url http://127.0.0.1:43739/api/board, or BOARD_URL=http://127.0.0.1:43739/api/board

exit 0; 15ms
```

```bash
rm -rf -- "${demo_dir:?}"
```

```text

exit 0; 7ms
```

## Relative-link check

```python
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

root = Path.cwd().resolve()
doc = root / 'docs/walkthrough.md'
body = re.sub(r'^```[^\n]*\n.*?^```\s*$', '', doc.read_text(), flags=re.M | re.S)
# The walkthrough uses only inline Markdown links with bare destinations.
links = re.findall(r'(?<!!)\[[^\]\n]+\]\(([^\s)]+)\)', body)
failed = checked = 0
for link in links:
    url = urlsplit(link)
    if url.scheme or url.netloc:
        continue
    checked += 1
    target = (doc.parent / unquote(url.path)).resolve() if url.path else doc
    inside = target.is_relative_to(root)
    ok = inside and target.exists()
    print(f'{"PASS" if ok else "FAIL"} {link} -> {target.relative_to(root) if inside else target}')
    failed += not ok
print(f'{checked - failed}/{checked} relative links resolve inside the checkout')
raise SystemExit(int(failed != 0 or checked == 0))
```

```bash
python3 /tmp/wp904/check-links.py
```

```text
PASS ../package.json -> package.json
PASS ../packages/board/docs/01-board/10-local.md -> packages/board/docs/01-board/10-local.md
PASS ../LOCAL-DEVELOPMENT.md -> LOCAL-DEVELOPMENT.md
PASS ../design/swarm-party-config.md -> design/swarm-party-config.md
PASS ../design/swarm-work-items.md -> design/swarm-work-items.md
PASS ../design/work-lifecycle.md -> design/work-lifecycle.md
PASS ../design/swarm-overview.md -> design/swarm-overview.md
7/7 relative links resolve inside the checkout

exit 0; 41ms
```

```bash
git rev-parse HEAD
```

```text
c4be9936f5915d7f2625ec4f367973974b25a627

exit 0; 3ms
```

```bash
git status --short
```

```text

exit 0; 15ms
```

```bash
file /tmp/wp904/0{1-ready,2-running,3-left-work,4-completed}.png
```

```text
/tmp/wp904/01-ready.png:     PNG image data, 1440 x 1000, 8-bit/color RGB, non-interlaced
/tmp/wp904/02-running.png:   PNG image data, 1440 x 1000, 8-bit/color RGB, non-interlaced
/tmp/wp904/03-left-work.png: PNG image data, 1440 x 1000, 8-bit/color RGB, non-interlaced
/tmp/wp904/04-completed.png: PNG image data, 1440 x 1000, 8-bit/color RGB, non-interlaced

exit 0; 6ms
```

Total wall-clock time from clone start through checks, including harness retries: 313s. No doc changes or commits.
