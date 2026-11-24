# WP-904 cold run

## Step 0

```bash
RUN=$(mktemp -d)/politburo && git clone -q /home/user/politburo "$RUN" && git -C "$RUN" checkout -q claude/keen-einstein-2gru36 && git -C "$RUN" status --short
```

```text
```
Exit 0; 596 ms.

```bash
whoami
```

```text
root
```
Exit 0; 4 ms.

```bash
id -u
```

```text
0
```
Exit 0; 7 ms.

Running as root: the swarm permission case is expected to skip, unlike under a normal user.

## Step 1: walkthrough

Did not execute the opening `git clone --branch main https://github.com/remiliacorporation/politburo.git` and `cd politburo` blocks: they conflict with the required fresh branch checkout and working directory in Step 0.

```bash
node --version
```

```text
v22.23.5
```
Exit 0; 7 ms.

```bash
pnpm --version
```

```text
11.23.0
```
Exit 0; 752 ms.

```bash
git --version
```

```text
git version 2.43.0
```
Exit 0; 5 ms.

```bash
pnpm install
```

```text
devDependencies:
+ @changesets/cli 3.0.3

[WARN] Failed to create bin at /tmp/tmp.mJtzE2IKoA/politburo/apps/preview-publisher/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.mJtzE2IKoA/politburo/apps/preview-publisher/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.mJtzE2IKoA/politburo/apps/preview-publisher/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.mJtzE2IKoA/politburo/apps/preview-publisher/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.mJtzE2IKoA/politburo/packages/runtime/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.mJtzE2IKoA/politburo/packages/runtime/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.mJtzE2IKoA/politburo/packages/runtime/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.mJtzE2IKoA/politburo/packages/runtime/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.mJtzE2IKoA/politburo/packages/swarm/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.mJtzE2IKoA/politburo/packages/swarm/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.mJtzE2IKoA/politburo/packages/swarm/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.mJtzE2IKoA/politburo/packages/swarm/node_modules/@vercel/board/dist/cli.mjs'
Done in 1.2s using pnpm v11.23.0
```
Exit 0; 1592 ms.

```bash
pnpm --filter @remilia/politburo-swarm... build
```

```text
packages/board build:   - plugin tsdown:deps resolveId (302 calls)
packages/board build:   - plugin rolldown-plugin-dts:generate load (66 calls)
packages/board build:   … and 1 more
packages/board build: See https://rolldown.rs/reference/InputOptions.checks#bundlertimings for more details.
packages/board build: ✔ Build complete in 4695ms
packages/board build: Done
packages/runtime build$ tsc -p tsconfig.build.json
packages/runtime build: Done
packages/swarm build$ tsc -p tsconfig.build.json
packages/swarm build: Done
```
Exit 0; 6197 ms.

```bash
umask 077
```

```text
```
Exit 0; 3 ms.

```bash
demo_dir=$(mktemp -d /tmp/politburo.XXXXXX)
```

```text
```
Exit 0; 4 ms.

```bash
printf '%s\n' "$demo_dir"
```

```text
/tmp/politburo.lQ9sVm
```
Exit 0; 3 ms.

```bash
XDG_CONFIG_HOME="${demo_dir:?}/config" node packages/board/dist/cli.mjs serve --swarm --port 0 --dir "$demo_dir/data" --no-inspect
```
Background output: `/tmp/wp904-run.Mfb0Fa/board.out`.
```text
```
Startup: 5 ms; exit 127.

Stopped board (SIGTERM); process exit 127; 2 ms.

## Fresh restart: Steps 0–1

The earlier board launch failed in the background runner (assignment put after `exec`), not in the documented command. Restarting with the assignment before `exec`.

```bash
RUN=$(mktemp -d)/politburo && git clone -q /home/user/politburo "$RUN" && git -C "$RUN" checkout -q claude/keen-einstein-2gru36 && git -C "$RUN" status --short
```

```text
```
Exit 0; 557 ms.

```bash
whoami
```

```text
root
```
Exit 0; 4 ms.

```bash
id -u
```

```text
0
```
Exit 0; 5 ms.

Running as root: the swarm permission case is expected to skip, unlike under a normal user.

## Step 1: walkthrough

Did not execute the opening `git clone --branch main https://github.com/remiliacorporation/politburo.git` and `cd politburo` blocks: they conflict with the required fresh branch checkout and working directory in Step 0.

```bash
node --version
```

```text
v22.23.5
```
Exit 0; 7 ms.

```bash
pnpm --version
```

```text
11.23.0
```
Exit 0; 646 ms.

```bash
git --version
```

```text
git version 2.43.0
```
Exit 0; 5 ms.

```bash
pnpm install
```

```text
devDependencies:
+ @changesets/cli 3.0.3

[WARN] Failed to create bin at /tmp/tmp.m5p711ds9l/politburo/apps/preview-publisher/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.m5p711ds9l/politburo/apps/preview-publisher/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.m5p711ds9l/politburo/apps/preview-publisher/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.m5p711ds9l/politburo/apps/preview-publisher/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.m5p711ds9l/politburo/packages/runtime/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.m5p711ds9l/politburo/packages/runtime/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.m5p711ds9l/politburo/packages/runtime/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.m5p711ds9l/politburo/packages/runtime/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.m5p711ds9l/politburo/packages/swarm/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.m5p711ds9l/politburo/packages/swarm/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.m5p711ds9l/politburo/packages/swarm/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.m5p711ds9l/politburo/packages/swarm/node_modules/@vercel/board/dist/cli.mjs'
Done in 1.1s using pnpm v11.23.0
```
Exit 0; 1456 ms.

```bash
pnpm --filter @remilia/politburo-swarm... build
```

```text
packages/board build:   - plugin tsdown:deps resolveId (302 calls)
packages/board build:   - plugin rolldown-plugin-dts:generate load (66 calls)
packages/board build:   … and 1 more
packages/board build: See https://rolldown.rs/reference/InputOptions.checks#bundlertimings for more details.
packages/board build: ✔ Build complete in 4709ms
packages/board build: Done
packages/runtime build$ tsc -p tsconfig.build.json
packages/runtime build: Done
packages/swarm build$ tsc -p tsconfig.build.json
packages/swarm build: Done
```
Exit 0; 6272 ms.

```bash
umask 077
```

```text
```
Exit 0; 6 ms.

```bash
demo_dir=$(mktemp -d /tmp/politburo.XXXXXX)
```

```text
```
Exit 0; 5 ms.

```bash
printf '%s\n' "$demo_dir"
```

```text
/tmp/politburo.rAk8b4
```
Exit 0; 3 ms.

```bash
XDG_CONFIG_HOME="${demo_dir:?}/config" node packages/board/dist/cli.mjs serve --swarm --port 0 --dir "$demo_dir/data" --no-inspect
```
Background output: `/tmp/wp904-run.Mfb0Fa/board.out`.
```text
serving a local board at http://127.0.0.1:40261/api/board as local:user:root, its log in /tmp/politburo.rAk8b4/data  (Ctrl-C to stop)
```
Startup: 420 ms; still running.

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text
```
Exit 0; 3 ms.

```bash
cat > "${demo_dir:?}/party.yaml" <<'YAML'
party:
  id: local-demo
  name: Local Demo
  colour: '#356a8a'
YAML
```

```text
```
Exit 0; 4 ms.

```bash
node packages/swarm/dist/cli.js config validate --party "$demo_dir/party.yaml"
```

```text
valid
```
Exit 0; 154 ms.

### second terminal setup

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text
```
Exit 0; 3 ms.

```bash
read -r -p 'Board API URL: ' board_url
```

```text
```
Exit 0; 3 ms.

```bash
unset BOARD_NAME BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR
```

```text
```
Exit 0; 3 ms.

```bash
export XDG_CONFIG_HOME="${demo_dir:?}/config"
```

```text
```
Exit 0; 3 ms.

```bash
vb() { node packages/board/dist/cli.mjs --url "${board_url:?}" "$@"; }
```

```text
```
Exit 0; 3 ms.

### third terminal setup

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text
```
Exit 0; 3 ms.

```bash
read -r -p 'Board API URL: ' board_url
```

```text
```
Exit 0; 3 ms.

```bash
unset BOARD_NAME BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR
```

```text
```
Exit 0; 3 ms.

```bash
export XDG_CONFIG_HOME="${demo_dir:?}/config"
```

```text
```
Exit 0; 3 ms.

```bash
vb() { node packages/board/dist/cli.mjs --url "${board_url:?}" "$@"; }
```

```text
```
Exit 0; 3 ms.

```bash
vb inspect --port 0 --no-open
```
Background output: `/tmp/wp904-run.Mfb0Fa/inspector.out`.
```text
inspecting http://127.0.0.1:40261/api/board as root at http://127.0.0.1:40837  (Ctrl-C to stop)
```
Startup: 315 ms; still running.

```bash
vb tasks create work/acme/web 'Confirm the local work board' --no-sync
```

```text
2
```
Exit 0; 252 ms.

Stopped inspector (SIGTERM); process exit 0; 11 ms.

Stopped board (SIGTERM); process exit 0; 14 ms.

## Fresh restart: Steps 0–1

Restarting after runner errors: the board assignment must precede `exec`, and the create command printed a bare numeric ID, not the runner’s expected `#` prefix. The documented create command succeeded.

```bash
RUN=$(mktemp -d)/politburo && git clone -q /home/user/politburo "$RUN" && git -C "$RUN" checkout -q claude/keen-einstein-2gru36 && git -C "$RUN" status --short
```

```text
```
Exit 0; 556 ms.

```bash
whoami
```

```text
root
```
Exit 0; 4 ms.

```bash
id -u
```

```text
0
```
Exit 0; 5 ms.

Running as root: the swarm permission case is expected to skip, unlike under a normal user.

## Step 1: walkthrough

Did not execute the opening `git clone --branch main https://github.com/remiliacorporation/politburo.git` and `cd politburo` blocks: they conflict with the required fresh branch checkout and working directory in Step 0.

```bash
node --version
```

```text
v22.23.5
```
Exit 0; 6 ms.

```bash
pnpm --version
```

```text
11.23.0
```
Exit 0; 626 ms.

```bash
git --version
```

```text
git version 2.43.0
```
Exit 0; 5 ms.

```bash
pnpm install
```

```text
devDependencies:
+ @changesets/cli 3.0.3

[WARN] Failed to create bin at /tmp/tmp.XoUwH3zGQk/politburo/apps/preview-publisher/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.XoUwH3zGQk/politburo/apps/preview-publisher/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.XoUwH3zGQk/politburo/apps/preview-publisher/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.XoUwH3zGQk/politburo/apps/preview-publisher/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.XoUwH3zGQk/politburo/packages/runtime/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.XoUwH3zGQk/politburo/packages/runtime/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.XoUwH3zGQk/politburo/packages/runtime/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.XoUwH3zGQk/politburo/packages/runtime/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.XoUwH3zGQk/politburo/packages/swarm/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.XoUwH3zGQk/politburo/packages/swarm/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.XoUwH3zGQk/politburo/packages/swarm/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.XoUwH3zGQk/politburo/packages/swarm/node_modules/@vercel/board/dist/cli.mjs'
Done in 1.2s using pnpm v11.23.0
```
Exit 0; 1515 ms.

```bash
pnpm --filter @remilia/politburo-swarm... build
```

```text
packages/board build:   - plugin tsdown:deps resolveId (302 calls)
packages/board build:   - plugin rolldown-plugin-dts:generate load (66 calls)
packages/board build:   … and 1 more
packages/board build: See https://rolldown.rs/reference/InputOptions.checks#bundlertimings for more details.
packages/board build: ✔ Build complete in 4866ms
packages/board build: Done
packages/runtime build$ tsc -p tsconfig.build.json
packages/runtime build: Done
packages/swarm build$ tsc -p tsconfig.build.json
packages/swarm build: Done
```
Exit 0; 6469 ms.

```bash
umask 077
```

```text
```
Exit 0; 3 ms.

```bash
demo_dir=$(mktemp -d /tmp/politburo.XXXXXX)
```

```text
```
Exit 0; 4 ms.

```bash
printf '%s\n' "$demo_dir"
```

```text
/tmp/politburo.AnRR8s
```
Exit 0; 3 ms.

```bash
XDG_CONFIG_HOME="${demo_dir:?}/config" node packages/board/dist/cli.mjs serve --swarm --port 0 --dir "$demo_dir/data" --no-inspect
```
Background output: `/tmp/wp904-run.Mfb0Fa/board.out`.
```text
serving a local board at http://127.0.0.1:36891/api/board as local:user:root, its log in /tmp/politburo.AnRR8s/data  (Ctrl-C to stop)
```
Startup: 316 ms; still running.

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text
```
Exit 0; 3 ms.

```bash
cat > "${demo_dir:?}/party.yaml" <<'YAML'
party:
  id: local-demo
  name: Local Demo
  colour: '#356a8a'
YAML
```

```text
```
Exit 0; 4 ms.

```bash
node packages/swarm/dist/cli.js config validate --party "$demo_dir/party.yaml"
```

```text
valid
```
Exit 0; 191 ms.

### second terminal setup

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text
```
Exit 0; 3 ms.

```bash
read -r -p 'Board API URL: ' board_url
```

```text
```
Exit 0; 5 ms.

```bash
unset BOARD_NAME BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR
```

```text
```
Exit 0; 3 ms.

```bash
export XDG_CONFIG_HOME="${demo_dir:?}/config"
```

```text
```
Exit 0; 4 ms.

```bash
vb() { node packages/board/dist/cli.mjs --url "${board_url:?}" "$@"; }
```

```text
```
Exit 0; 2 ms.

### third terminal setup

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text
```
Exit 0; 3 ms.

```bash
read -r -p 'Board API URL: ' board_url
```

```text
```
Exit 0; 3 ms.

```bash
unset BOARD_NAME BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR
```

```text
```
Exit 0; 4 ms.

```bash
export XDG_CONFIG_HOME="${demo_dir:?}/config"
```

```text
```
Exit 0; 3 ms.

```bash
vb() { node packages/board/dist/cli.mjs --url "${board_url:?}" "$@"; }
```

```text
```
Exit 0; 3 ms.

```bash
vb inspect --port 0 --no-open
```
Background output: `/tmp/wp904-run.Mfb0Fa/inspector.out`.
```text
inspecting http://127.0.0.1:36891/api/board as root at http://127.0.0.1:40691  (Ctrl-C to stop)
```
Startup: 319 ms; still running.

```bash
vb tasks create work/acme/web 'Confirm the local work board' --no-sync
```

```text
2
```
Exit 0; 302 ms.

```bash
node "$D/browser.cjs" "$inspector_url" ready "$D" "$printed_id"
```

```text
locator.click: Timeout 8000ms exceeded.
Call log:
[2m  - waiting for getByRole('link', { name: 'Work', exact: true })[22m

    at /tmp/wp904-run.Mfb0Fa/browser.cjs:8:63 {
  log: [
    "  - waiting for getByRole('link', { name: 'Work', exact: true })"
  ],
  name: 'TimeoutError'
}
```
Exit 1; 8788 ms.

```bash
read -r -p 'Task ID: ' task_id
```

```text
```
Exit 0; 4 ms.

```bash
vb tasks claim "${task_id:?}" --lease 15m
```

```text
#2  yours for 15m  Confirm the local work board
```
Exit 0; 412 ms.

```bash
node "$D/browser.cjs" "$inspector_url" running "$D" "$task_id"
```

```text
locator.click: Timeout 8000ms exceeded.
Call log:
[2m  - waiting for getByRole('link', { name: 'Work', exact: true })[22m

    at /tmp/wp904-run.Mfb0Fa/browser.cjs:8:63 {
  log: [
    "  - waiting for getByRole('link', { name: 'Work', exact: true })"
  ],
  name: 'TimeoutError'
}
```
Exit 1; 9007 ms.

```bash
vb tasks complete "${task_id:?}" 'UI verified'
```

```text
completed 2
```
Exit 0; 306 ms.

```bash
node "$D/browser.cjs" "$inspector_url" completed "$D" "$task_id"
```

```text
locator.click: Timeout 8000ms exceeded.
Call log:
[2m  - waiting for getByRole('link', { name: 'Work', exact: true })[22m

    at /tmp/wp904-run.Mfb0Fa/browser.cjs:8:63 {
  log: [
    "  - waiting for getByRole('link', { name: 'Work', exact: true })"
  ],
  name: 'TimeoutError'
}
```
Exit 1; 8745 ms.

```bash
pnpm --filter @remilia/politburo-swarm test
```

```text
ok 55 - status directory records a passing check below a search-only ancestor # SKIP root can bypass directory read permissions
# tests 340
# suites 1
# pass 339
# fail 0
# cancelled 0
# skipped 1
# todo 0
```
Exit 0; 28056 ms.

Stopped inspector (SIGTERM); process exit 0; 7 ms.

Stopped board (SIGTERM); process exit 0; 16 ms.

```bash
rm -rf -- "${demo_dir:?}"
```

```text
```
Exit 0; 11 ms.

## Step 2: shell

```bash
command -v zsh
```

```text
```
Exit 1; 3 ms.

zsh is not installed; no prompt-related edit.

## Step 4: relative links

Script:
```python
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

source = Path('docs/walkthrough.md')
links = []
for href in re.findall(r'(?<!!)\[[^\]\n]+\]\(([^)\s]+)\)', source.read_text()):
    url = urlsplit(href)
    if not url.scheme and not url.netloc and not url.path.startswith('/'):
        target = source.parent / unquote(url.path) if url.path else source
        links.append(target.is_file())
        print(f'{"OK" if links[-1] else "MISSING"} {href}')
print(f'{sum(links)}/{len(links)} relative links resolve to files')
raise SystemExit(not links or not all(links))
```

```bash
python3 "$D/links.py"
```

```text
OK ../package.json
OK ../packages/board/docs/01-board/10-local.md
OK ../LOCAL-DEVELOPMENT.md
OK ../design/swarm-party-config.md
OK ../design/swarm-work-items.md
OK ../design/work-lifecycle.md
6/6 relative links resolve to files
```
Exit 0; 56 ms.

## Fresh restart: Steps 0–1

Restart after runner errors. The last browser attempt opened the API URL (first URL on the inspector startup line); the documented inspector URL is the second URL, after `at`.

```bash
RUN=$(mktemp -d)/politburo && git clone -q /home/user/politburo "$RUN" && git -C "$RUN" checkout -q claude/keen-einstein-2gru36 && git -C "$RUN" status --short
```

```text
```
Exit 0; 679 ms.

```bash
whoami
```

```text
root
```
Exit 0; 4 ms.

```bash
id -u
```

```text
0
```
Exit 0; 5 ms.

Running as root: the swarm permission case is expected to skip, unlike under a normal user.

## Step 1: walkthrough

Did not execute the opening `git clone --branch main https://github.com/remiliacorporation/politburo.git` and `cd politburo` blocks: they conflict with the required fresh branch checkout and working directory in Step 0.

```bash
node --version
```

```text
v22.23.5
```
Exit 0; 10 ms.

```bash
pnpm --version
```

```text
11.23.0
```
Exit 0; 652 ms.

```bash
git --version
```

```text
git version 2.43.0
```
Exit 0; 5 ms.

```bash
pnpm install
```

```text
devDependencies:
+ @changesets/cli 3.0.3

[WARN] Failed to create bin at /tmp/tmp.C4TOFRWWuh/politburo/packages/runtime/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.C4TOFRWWuh/politburo/packages/runtime/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.C4TOFRWWuh/politburo/packages/runtime/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.C4TOFRWWuh/politburo/packages/runtime/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.C4TOFRWWuh/politburo/apps/preview-publisher/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.C4TOFRWWuh/politburo/apps/preview-publisher/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.C4TOFRWWuh/politburo/apps/preview-publisher/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.C4TOFRWWuh/politburo/apps/preview-publisher/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.C4TOFRWWuh/politburo/packages/swarm/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.C4TOFRWWuh/politburo/packages/swarm/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.C4TOFRWWuh/politburo/packages/swarm/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.C4TOFRWWuh/politburo/packages/swarm/node_modules/@vercel/board/dist/cli.mjs'
Done in 1.5s using pnpm v11.23.0
```
Exit 0; 1792 ms.

```bash
pnpm --filter @remilia/politburo-swarm... build
```

```text
packages/board build:   - plugin tsdown:deps resolveId (302 calls)
packages/board build:   - plugin rolldown-plugin-dts:generate load (66 calls)
packages/board build:   … and 1 more
packages/board build: See https://rolldown.rs/reference/InputOptions.checks#bundlertimings for more details.
packages/board build: ✔ Build complete in 6285ms
packages/board build: Done
packages/runtime build$ tsc -p tsconfig.build.json
packages/runtime build: Done
packages/swarm build$ tsc -p tsconfig.build.json
packages/swarm build: Done
```
Exit 0; 8241 ms.

```bash
umask 077
```

```text
```
Exit 0; 3 ms.

```bash
demo_dir=$(mktemp -d /tmp/politburo.XXXXXX)
```

```text
```
Exit 0; 6 ms.

```bash
printf '%s\n' "$demo_dir"
```

```text
/tmp/politburo.VZixf3
```
Exit 0; 2 ms.

```bash
XDG_CONFIG_HOME="${demo_dir:?}/config" node packages/board/dist/cli.mjs serve --swarm --port 0 --dir "$demo_dir/data" --no-inspect
```
Background output: `/tmp/wp904-run.Mfb0Fa/board.out`.
```text
serving a local board at http://127.0.0.1:46173/api/board as local:user:root, its log in /tmp/politburo.VZixf3/data  (Ctrl-C to stop)
```
Startup: 324 ms; still running.

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text
```
Exit 0; 3 ms.

```bash
cat > "${demo_dir:?}/party.yaml" <<'YAML'
party:
  id: local-demo
  name: Local Demo
  colour: '#356a8a'
YAML
```

```text
```
Exit 0; 4 ms.

```bash
node packages/swarm/dist/cli.js config validate --party "$demo_dir/party.yaml"
```

```text
valid
```
Exit 0; 171 ms.

### second terminal setup

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text
```
Exit 0; 3 ms.

```bash
read -r -p 'Board API URL: ' board_url
```

```text
```
Exit 0; 3 ms.

```bash
unset BOARD_NAME BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR
```

```text
```
Exit 0; 3 ms.

```bash
export XDG_CONFIG_HOME="${demo_dir:?}/config"
```

```text
```
Exit 0; 3 ms.

```bash
vb() { node packages/board/dist/cli.mjs --url "${board_url:?}" "$@"; }
```

```text
```
Exit 0; 3 ms.

### third terminal setup

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text
```
Exit 0; 3 ms.

```bash
read -r -p 'Board API URL: ' board_url
```

```text
```
Exit 0; 3 ms.

```bash
unset BOARD_NAME BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR
```

```text
```
Exit 0; 3 ms.

```bash
export XDG_CONFIG_HOME="${demo_dir:?}/config"
```

```text
```
Exit 0; 3 ms.

```bash
vb() { node packages/board/dist/cli.mjs --url "${board_url:?}" "$@"; }
```

```text
```
Exit 0; 3 ms.

```bash
vb inspect --port 0 --no-open
```
Background output: `/tmp/wp904-run.Mfb0Fa/inspector.out`.
```text
inspecting http://127.0.0.1:46173/api/board as root at http://127.0.0.1:42741  (Ctrl-C to stop)
```
Startup: 320 ms; still running.

```bash
vb tasks create work/acme/web 'Confirm the local work board' --no-sync
```

```text
2
```
Exit 0; 283 ms.

```bash
node "$D/browser.cjs" "$inspector_url" ready "$D" "$printed_id"
```

```text
Observed task in Ready to pull.
```
Exit 0; 792 ms.

```bash
read -r -p 'Task ID: ' task_id
```

```text
```
Exit 0; 3 ms.

```bash
vb tasks claim "${task_id:?}" --lease 15m
```

```text
#2  yours for 15m  Confirm the local work board
```
Exit 0; 308 ms.

```bash
node "$D/browser.cjs" "$inspector_url" running "$D" "$task_id"
```

```text
Observed task in Running now.
```
Exit 0; 860 ms.

```bash
vb tasks complete "${task_id:?}" 'UI verified'
```

```text
completed 2
```
Exit 0; 278 ms.

```bash
node "$D/browser.cjs" "$inspector_url" completed "$D" "$task_id"
```

```text
Completed task no longer appears on Work.
Tasks > completed shows the task and result UI verified (2).
```
Exit 0; 1006 ms.

```bash
pnpm --filter @remilia/politburo-swarm test
```

```text
ok 55 - status directory records a passing check below a search-only ancestor # SKIP root can bypass directory read permissions
# tests 340
# suites 1
# pass 339
# fail 0
# cancelled 0
# skipped 1
# todo 0
```
Exit 0; 37653 ms.

Stopped inspector (SIGTERM); process exit 0; 9 ms.

Stopped board (SIGTERM); process exit 0; 23 ms.

```bash
rm -rf -- "${demo_dir:?}"
```

```text
```
Exit 0; 8 ms.

## Step 2: shell

```bash
command -v zsh
```

```text
```
Exit 1; 3 ms.

zsh is not installed; no prompt-related edit.

## Step 4: relative links

Script:
```python
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

source = Path('docs/walkthrough.md')
links = []
for href in re.findall(r'(?<!!)\[[^\]\n]+\]\(([^)\s]+)\)', source.read_text()):
    url = urlsplit(href)
    if not url.scheme and not url.netloc and not url.path.startswith('/'):
        target = source.parent / unquote(url.path) if url.path else source
        links.append(target.is_file())
        print(f'{"OK" if links[-1] else "MISSING"} {href}')
print(f'{sum(links)}/{len(links)} relative links resolve to files')
raise SystemExit(not links or not all(links))
```

```bash
python3 "$D/links.py"
```

```text
OK ../package.json
OK ../packages/board/docs/01-board/10-local.md
OK ../LOCAL-DEVELOPMENT.md
OK ../design/swarm-party-config.md
OK ../design/swarm-work-items.md
OK ../design/work-lifecycle.md
6/6 relative links resolve to files
```
Exit 0; 29 ms.

## Step 5: local commit

[claude/keen-einstein-2gru36 5663935] docs(walkthrough): clarify checkout and running state
 1 file changed, 5 insertions(+), 3 deletions(-)
Exit 0; 176 ms.

## Step 5: fresh rerun of the local fix

```bash
RUN=$(mktemp -d)/politburo && git clone -q "$1" "$RUN" && git -C "$RUN" checkout -q claude/keen-einstein-2gru36 && git -C "$RUN" status --short
```

```text
fatal: repository 'RUN=$(mktemp -d)/politburo && git clone -q "$1" "$RUN" && git -C "$RUN" checkout -q claude/keen-einstein-2gru36 && git -C "$RUN" status --short' does not exist
```
Exit 128; 8 ms.

## Step 5: fresh rerun of the local fix

```bash
RUN=$(mktemp -d)/politburo && git clone -q "$source_checkout" "$RUN" && git -C "$RUN" checkout -q claude/keen-einstein-2gru36 && git -C "$RUN" status --short
```

```text
```
Exit 0; 539 ms.

```bash
git rev-parse HEAD
```

```text
56639352fb5bf91fdacc2c6e8cbf21a5fa68cca9
```
Exit 0; 4 ms.

```bash
node --version
```

```text
v22.23.5
```
Exit 0; 6 ms.

```bash
pnpm --version
```

```text
11.23.0
```
Exit 0; 688 ms.

```bash
git --version
```

```text
git version 2.43.0
```
Exit 0; 5 ms.

```bash
pnpm install
```

```text
devDependencies:
+ @changesets/cli 3.0.3

[WARN] Failed to create bin at /tmp/tmp.rO7WHBMcc7/politburo/apps/preview-publisher/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.rO7WHBMcc7/politburo/apps/preview-publisher/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.rO7WHBMcc7/politburo/apps/preview-publisher/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.rO7WHBMcc7/politburo/apps/preview-publisher/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.rO7WHBMcc7/politburo/packages/runtime/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.rO7WHBMcc7/politburo/packages/runtime/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.rO7WHBMcc7/politburo/packages/runtime/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.rO7WHBMcc7/politburo/packages/runtime/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.rO7WHBMcc7/politburo/packages/swarm/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.rO7WHBMcc7/politburo/packages/swarm/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.rO7WHBMcc7/politburo/packages/swarm/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.rO7WHBMcc7/politburo/packages/swarm/node_modules/@vercel/board/dist/cli.mjs'
Done in 1.2s using pnpm v11.23.0
```
Exit 0; 1530 ms.

```bash
pnpm --filter @remilia/politburo-swarm... build
```

```text
packages/board build:   - plugin tsdown:deps resolveId (302 calls)
packages/board build:   - plugin rolldown-plugin-dts:generate load (66 calls)
packages/board build:   … and 1 more
packages/board build: See https://rolldown.rs/reference/InputOptions.checks#bundlertimings for more details.
packages/board build: ✔ Build complete in 4632ms
packages/board build: Done
packages/runtime build$ tsc -p tsconfig.build.json
packages/runtime build: Done
packages/swarm build$ tsc -p tsconfig.build.json
packages/swarm build: Done
```
Exit 0; 6217 ms.

```bash
umask 077
```

```text
```
Exit 0; 3 ms.

```bash
demo_dir=$(mktemp -d /tmp/politburo.XXXXXX)
```

```text
```
Exit 0; 5 ms.

```bash
printf '%s\n' "$demo_dir"
```

```text
/tmp/politburo.aobeyo
```
Exit 0; 2 ms.

```bash
XDG_CONFIG_HOME="${demo_dir:?}/config" node packages/board/dist/cli.mjs serve --swarm --port 0 --dir "$demo_dir/data" --no-inspect
```
Background output: `/tmp/wp904-run.Mfb0Fa/board.out`.
```text
serving a local board at http://127.0.0.1:44299/api/board as local:user:root, its log in /tmp/politburo.aobeyo/data  (Ctrl-C to stop)
```
Startup: 316 ms; still running.

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text
```
Exit 0; 3 ms.

```bash
cat > "${demo_dir:?}/party.yaml" <<'YAML'
party:
  id: local-demo
  name: Local Demo
  colour: '#356a8a'
YAML
```

```text
```
Exit 0; 4 ms.

```bash
node packages/swarm/dist/cli.js config validate --party "$demo_dir/party.yaml"
```

```text
valid
```
Exit 0; 250 ms.

### second terminal setup

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text
```
Exit 0; 3 ms.

```bash
read -r -p 'Board API URL: ' board_url
```

```text
```
Exit 0; 3 ms.

```bash
unset BOARD_NAME BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR
```

```text
```
Exit 0; 3 ms.

```bash
export XDG_CONFIG_HOME="${demo_dir:?}/config"
```

```text
```
Exit 0; 3 ms.

```bash
vb() { node packages/board/dist/cli.mjs --url "${board_url:?}" "$@"; }
```

```text
```
Exit 0; 3 ms.

### third terminal setup

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text
```
Exit 0; 3 ms.

```bash
read -r -p 'Board API URL: ' board_url
```

```text
```
Exit 0; 3 ms.

```bash
unset BOARD_NAME BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR
```

```text
```
Exit 0; 3 ms.

```bash
export XDG_CONFIG_HOME="${demo_dir:?}/config"
```

```text
```
Exit 0; 3 ms.

```bash
vb() { node packages/board/dist/cli.mjs --url "${board_url:?}" "$@"; }
```

```text
```
Exit 0; 3 ms.

```bash
vb inspect --port 0 --no-open
```
Background output: `/tmp/wp904-run.Mfb0Fa/inspector.out`.
```text
inspecting http://127.0.0.1:44299/api/board as root at http://127.0.0.1:40991  (Ctrl-C to stop)
```
Startup: 316 ms; still running.

```bash
vb tasks create work/acme/web 'Confirm the local work board' --no-sync
```

```text
2
```
Exit 0; 310 ms.

```bash
node "$D/browser.cjs" "$inspector_url" ready "$D" "$printed_id"
```

```text
Observed task in Ready to pull.
```
Exit 0; 831 ms.

```bash
read -r -p 'Task ID: ' task_id
```

```text
```
Exit 0; 3 ms.

```bash
vb tasks claim "${task_id:?}" --lease 15m
```

```text
#2  yours for 15m  Confirm the local work board
```
Exit 0; 269 ms.

```bash
node "$D/browser.cjs" "$inspector_url" running "$D" "$task_id"
```

```text
Observed task in Running now.
```
Exit 0; 696 ms.

```bash
vb tasks complete "${task_id:?}" 'UI verified'
```

```text
completed 2
```
Exit 0; 242 ms.

```bash
node "$D/browser.cjs" "$inspector_url" completed "$D" "$task_id"
```

```text
Completed task no longer appears on Work.
Tasks > completed shows the task and result UI verified (2).
```
Exit 0; 854 ms.

```bash
pnpm --filter @remilia/politburo-swarm test
```

```text
ok 55 - status directory records a passing check below a search-only ancestor # SKIP root can bypass directory read permissions
# tests 340
# suites 1
# pass 339
# fail 0
# cancelled 0
# skipped 1
# todo 0
```
Exit 0; 28650 ms.

Stopped inspector (SIGTERM); process exit 0; 9 ms.

Stopped board (SIGTERM); process exit 0; 21 ms.

```bash
rm -rf -- "${demo_dir:?}"
```

```text
```
Exit 0; 9 ms.

## Step 4: relative links

Script:
```python
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

source = Path('docs/walkthrough.md')
links = []
for href in re.findall(r'(?<!!)\[[^\]\n]+\]\(([^)\s]+)\)', source.read_text()):
    url = urlsplit(href)
    if not url.scheme and not url.netloc and not url.path.startswith('/'):
        target = source.parent / unquote(url.path) if url.path else source
        links.append(target.is_file())
        print(f'{"OK" if links[-1] else "MISSING"} {href}')
print(f'{sum(links)}/{len(links)} relative links resolve to files')
raise SystemExit(not links or not all(links))
```

```bash
python3 "$D/links.py"
```

```text
OK ../package.json
OK ../packages/board/docs/01-board/10-local.md
OK ../LOCAL-DEVELOPMENT.md
OK ../design/swarm-party-config.md
OK ../design/swarm-work-items.md
OK ../design/work-lifecycle.md
6/6 relative links resolve to files
```
Exit 0; 31 ms.

### Apply the fix on the updated branch tip

The original checkout advanced independently during the first rerun. A fresh clone at `f9e23a5` retains the existing Bash note and swarm overview link.

[claude/keen-einstein-2gru36 170a8e0] docs(walkthrough): clarify checkout and running state
 1 file changed, 5 insertions(+), 3 deletions(-)
Exit 0; 168 ms.

## Step 5: fresh rerun of the local fix

```bash
RUN=$(mktemp -d)/politburo && git clone -q "$source_checkout" "$RUN" && git -C "$RUN" checkout -q claude/keen-einstein-2gru36 && git -C "$RUN" status --short
```

```text
```
Exit 0; 467 ms.

```bash
git rev-parse HEAD
```

```text
170a8e0a7da7fcd132f0d0a533f198a7fbc13a8a
```
Exit 0; 5 ms.

```bash
node --version
```

```text
v22.23.5
```
Exit 0; 6 ms.

```bash
pnpm --version
```

```text
11.23.0
```
Exit 0; 670 ms.

```bash
git --version
```

```text
git version 2.43.0
```
Exit 0; 5 ms.

```bash
pnpm install
```

```text
devDependencies:
+ @changesets/cli 3.0.3

[WARN] Failed to create bin at /tmp/tmp.gEeW54I5GO/politburo/apps/preview-publisher/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.gEeW54I5GO/politburo/apps/preview-publisher/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.gEeW54I5GO/politburo/apps/preview-publisher/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.gEeW54I5GO/politburo/apps/preview-publisher/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.gEeW54I5GO/politburo/packages/runtime/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.gEeW54I5GO/politburo/packages/runtime/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.gEeW54I5GO/politburo/packages/runtime/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.gEeW54I5GO/politburo/packages/runtime/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.gEeW54I5GO/politburo/packages/swarm/node_modules/.bin/board. ENOENT: no such file or directory, open '/tmp/tmp.gEeW54I5GO/politburo/packages/swarm/node_modules/@vercel/board/dist/cli.mjs'
[WARN] Failed to create bin at /tmp/tmp.gEeW54I5GO/politburo/packages/swarm/node_modules/.bin/vb. ENOENT: no such file or directory, open '/tmp/tmp.gEeW54I5GO/politburo/packages/swarm/node_modules/@vercel/board/dist/cli.mjs'
Done in 1.2s using pnpm v11.23.0
```
Exit 0; 1511 ms.

```bash
pnpm --filter @remilia/politburo-swarm... build
```

```text
packages/board build:   - plugin tsdown:deps resolveId (302 calls)
packages/board build:   - plugin rolldown-plugin-dts:generate load (66 calls)
packages/board build:   … and 1 more
packages/board build: See https://rolldown.rs/reference/InputOptions.checks#bundlertimings for more details.
packages/board build: ✔ Build complete in 4522ms
packages/board build: Done
packages/runtime build$ tsc -p tsconfig.build.json
packages/runtime build: Done
packages/swarm build$ tsc -p tsconfig.build.json
packages/swarm build: Done
```
Exit 0; 6088 ms.

```bash
umask 077
```

```text
```
Exit 0; 20 ms.

```bash
demo_dir=$(mktemp -d /tmp/politburo.XXXXXX)
```

```text
```
Exit 0; 8 ms.

```bash
printf '%s\n' "$demo_dir"
```

```text
/tmp/politburo.8mNcyu
```
Exit 0; 4 ms.

```bash
XDG_CONFIG_HOME="${demo_dir:?}/config" node packages/board/dist/cli.mjs serve --swarm --port 0 --dir "$demo_dir/data" --no-inspect
```
Background output: `/tmp/wp904-run.Mfb0Fa/board.out`.
```text
serving a local board at http://127.0.0.1:42693/api/board as local:user:root, its log in /tmp/politburo.8mNcyu/data  (Ctrl-C to stop)
```
Startup: 316 ms; still running.

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text
```
Exit 0; 3 ms.

```bash
cat > "${demo_dir:?}/party.yaml" <<'YAML'
party:
  id: local-demo
  name: Local Demo
  colour: '#356a8a'
YAML
```

```text
```
Exit 0; 6 ms.

```bash
node packages/swarm/dist/cli.js config validate --party "$demo_dir/party.yaml"
```

```text
valid
```
Exit 0; 160 ms.

### second terminal setup

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text
```
Exit 0; 3 ms.

```bash
read -r -p 'Board API URL: ' board_url
```

```text
```
Exit 0; 2 ms.

```bash
unset BOARD_NAME BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR
```

```text
```
Exit 0; 3 ms.

```bash
export XDG_CONFIG_HOME="${demo_dir:?}/config"
```

```text
```
Exit 0; 3 ms.

```bash
vb() { node packages/board/dist/cli.mjs --url "${board_url:?}" "$@"; }
```

```text
```
Exit 0; 3 ms.

### third terminal setup

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```text
```
Exit 0; 3 ms.

```bash
read -r -p 'Board API URL: ' board_url
```

```text
```
Exit 0; 3 ms.

```bash
unset BOARD_NAME BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR
```

```text
```
Exit 0; 2 ms.

```bash
export XDG_CONFIG_HOME="${demo_dir:?}/config"
```

```text
```
Exit 0; 4 ms.

```bash
vb() { node packages/board/dist/cli.mjs --url "${board_url:?}" "$@"; }
```

```text
```
Exit 0; 2 ms.

```bash
vb inspect --port 0 --no-open
```
Background output: `/tmp/wp904-run.Mfb0Fa/inspector.out`.
```text
inspecting http://127.0.0.1:42693/api/board as root at http://127.0.0.1:42739  (Ctrl-C to stop)
```
Startup: 325 ms; still running.

```bash
vb tasks create work/acme/web 'Confirm the local work board' --no-sync
```

```text
2
```
Exit 0; 254 ms.

```bash
node "$D/browser.cjs" "$inspector_url" ready "$D" "$printed_id"
```

```text
Observed task in Ready to pull.
```
Exit 0; 713 ms.

```bash
read -r -p 'Task ID: ' task_id
```

```text
```
Exit 0; 3 ms.

```bash
vb tasks claim "${task_id:?}" --lease 15m
```

```text
#2  yours for 15m  Confirm the local work board
```
Exit 0; 296 ms.

```bash
node "$D/browser.cjs" "$inspector_url" running "$D" "$task_id"
```

```text
Observed task in Running now.
```
Exit 0; 713 ms.

```bash
vb tasks complete "${task_id:?}" 'UI verified'
```

```text
completed 2
```
Exit 0; 220 ms.

```bash
node "$D/browser.cjs" "$inspector_url" completed "$D" "$task_id"
```

```text
Completed task no longer appears on Work.
Tasks > completed shows the task and result UI verified (2).
```
Exit 0; 817 ms.

```bash
pnpm --filter @remilia/politburo-swarm test
```

```text
ok 55 - status directory records a passing check below a search-only ancestor # SKIP root can bypass directory read permissions
# tests 437
# suites 1
# pass 436
# fail 0
# cancelled 0
# skipped 1
# todo 0
```
Exit 0; 36520 ms.

Stopped inspector (SIGTERM); process exit 0; 8 ms.

Stopped board (SIGTERM); process exit 0; 13 ms.

```bash
rm -rf -- "${demo_dir:?}"
```

```text
```
Exit 0; 8 ms.

## Step 4: relative links

Script:
```python
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

source = Path('docs/walkthrough.md')
links = []
for href in re.findall(r'(?<!!)\[[^\]\n]+\]\(([^)\s]+)\)', source.read_text()):
    url = urlsplit(href)
    if not url.scheme and not url.netloc and not url.path.startswith('/'):
        target = source.parent / unquote(url.path) if url.path else source
        links.append(target.is_file())
        print(f'{"OK" if links[-1] else "MISSING"} {href}')
print(f'{sum(links)}/{len(links)} relative links resolve to files')
raise SystemExit(not links or not all(links))
```

```bash
python3 "$D/links.py"
```

```text
OK ../package.json
OK ../packages/board/docs/01-board/10-local.md
OK ../LOCAL-DEVELOPMENT.md
OK ../design/swarm-party-config.md
OK ../design/swarm-work-items.md
OK ../design/work-lifecycle.md
OK ../design/swarm-overview.md
7/7 relative links resolve to files
```
Exit 0; 29 ms.

### Commit the verified document in the original checkout

[claude/keen-einstein-2gru36 c4be993] docs(walkthrough): clarify checkout and running state
 1 file changed, 5 insertions(+), 3 deletions(-)
Exit 0; 76 ms.

`git status --short`:

```text
```
Exit 0; 9 ms.
c4be993

Screenshots at device scale 1: `/tmp/wp904/work-ready.png`, `/tmp/wp904/work-running.png`, `/tmp/wp904/work-after-completion.png`, `/tmp/wp904/work-completed.png`. Final background output copies: `/tmp/wp904/wp904-board.out` and `/tmp/wp904/wp904-inspector.out`.

Total elapsed wall time (including setup and retries): 495 seconds.
