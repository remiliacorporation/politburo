---
title: Self-host a board
description: Run a board on your own machine with SQLite and files. Give each teammate a token, or let Tailscale name them. No Vercel account needed.
---

## Run it

Use Node.js 22.18 or later and a build of `@vercel/board` with `vb serve --team-tokens`.
For a build on npm, install the CLI on the machine that keeps the board:

```bash
npm install -g @vercel/board
```

Create the token file once, in Bash. Set the handles in the sample before
running it. Keep the token file and data directory private and outside your
repos. The command refuses to overwrite the file and prints no tokens.

```bash
(
  umask 077
  mkdir -p "$HOME/.config/board-self-host" "$HOME/.local/share/board/data" &&
  chmod 700 "$HOME/.config/board-self-host" "$HOME/.local/share/board/data" &&
  node --input-type=module - "$HOME/.config/board-self-host/team-tokens.json" <<'NODE'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const handles = ['ada', 'sam']
const tokens = Object.fromEntries(handles.map((handle) => [handle, randomBytes(32).toString('hex')]))
writeFileSync(process.argv[2], JSON.stringify(tokens, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
NODE
)
```

The file is a nonempty JSON object. Each key is a handle of 1 to 64 characters.
Use lowercase letters, digits, `.`, `_`, or `-`, with a letter or digit at each
end. Each value is a unique string of 64 lowercase hex characters.

Start `vb serve` outside Vercel, from an unlinked directory (no
`.vercel/project.json`) and without Vercel project environment variables.
Otherwise the board can advertise a Vercel project and team in discovery.
This matters on a tokenless tailnet: `vb` can try your Vercel login instead.
In an ordinary environment, a plain HTTP client with an explicit `BOARD_TOKEN`
is unaffected.

Replace `board.example.com` with your proxy's hostname. Leave off `--allow-host`
if you only want to reach the board on this machine.

```bash
(
  umask 077
  cd "$HOME/.local/share/board" &&
  unset VERCEL VERCEL_PROJECT_ID VERCEL_ORG_ID &&
  vb serve --dir "$HOME/.local/share/board/data" --host 127.0.0.1 --port 4100 \
    --team-tokens "$HOME/.config/board-self-host/team-tokens.json" \
    --allow-host board.example.com
)
```

`--host` defaults to `127.0.0.1`. It takes a literal bind IP, not a hostname or
an unspecified address such as `0.0.0.0` or `::`. Only team mode takes `--host`.
Keep the loopback default when the TLS proxy runs on this machine.

The `board` line gives the direct API URL, `http://127.0.0.1:4100/api/board`
here. Each `share` line gives the HTTPS API URL for an allowed proxy host.
Neither line prints credentials. `--allow-host` does not start a proxy or turn
on TLS.

Team mode serves the API only. It starts no embedded inspector and neither
mints a local JWT nor writes a local login token file. It keeps the log in
SQLite and uploads beside it. It has no sync or watchers of its own.

## Use a TLS proxy

Put a TLS reverse proxy on the board's machine. Keep the upstream port private.
Keep the public `Host` header and have the proxy set `X-Forwarded-Proto: https`.
Do not log `Authorization` headers. Use direct HTTP only for loopback or for
the same machine's trusted proxy. Never send a token over cleartext on the network.

For example, point `board.example.com` at the proxy machine and add this site to
its Caddyfile. Use the same hostname you passed to `--allow-host`. Caddy needs
public ports 80 and 443 for this setup.

```text Caddyfile
board.example.com {
    reverse_proxy 127.0.0.1:4100
}
```

Reload Caddy. Once the HTTPS proxy is up, share `https://board.example.com/api/board`, the URL
from `share`. The direct `board` URL is not the one to give teammates.

## Join the board

Send each person only their own token through a password manager or another
private channel. Use separate tokens for each board. Never put tokens in Git,
URLs, command arguments, or logs.
Each handle names a stable person, `team:user:<handle>`. A new token for the same
handle keeps that identity. To rotate a token, replace its value and restart
the board, which reads the file at startup.

> [!WARNING]
> Every token holder is a person under the board's [grants](../01-board/09-access.md#grants).
> The starting grant `g1` gives every person full access, including `manage`.
> Review and narrow it before inviting people. Keep an operator with `manage` at `*`.

On a teammate's machine, replace the URL below with the board's `share` URL.
Run this in Bash. Paste your token at the hidden prompt, not into the command.

```bash
export BOARD_URL=https://board.example.com/api/board
set +x
unset BOARD_TOKEN
IFS= read -rs -p 'Board token: ' BOARD_TOKEN && { printf '\n'; export BOARD_TOKEN; }
```

```bash
vb whoami
```

`vb whoami` names your own `team:user:<handle>`. Create a task, run a command
that exits successfully, and check the completed task. Use only commands you
trust with your environment.

```bash
task_id=$(vb tasks create self-host 'Check the self-hosted board') &&
  vb tasks run "$task_id" --result 'Board is reachable' -- true &&
  vb tasks self-host --state completed
```

```bash
vb inspect --no-open
```

Open the loopback URL it prints on that same machine. The inspector reads and
writes as you. Don't publish an inspector that acts as the operator for everyone.
Stop it with Ctrl-C.

In Node, `board()` uses the same `BOARD_URL` and `BOARD_TOKEN`. In a project with
`@vercel/board` installed, run this with `node self-host.mjs` in the same shell:

```js self-host.mjs
import { board } from '@vercel/board'

const team = board()
const { tasks } = await team.tasks.list({ channel: 'self-host', state: 'completed' })
console.log(tasks)
```

Run `unset BOARD_TOKEN` when you're done.

### Offboard a teammate

Remove their entry, keeping the file nonempty, and restart the board. This
stops new calls with that bearer token. The handle keeps its grants, pending
schedule records, watcher registrations, and queued matches. A registration
can still queue matches while the teammate is gone. Don't recycle handles:
a new token for that handle can pull its queued matches.

Review [grants](../01-board/09-access.md#grants) and
[pending schedules](../01-board/07-schedules.md#listing-and-canceling) separately.
Cancel pending schedules as needed. Restarting stops their timers, not their
records.

## Use a tailnet instead

If everyone is on a tailnet, use `vb serve --tailscale` behind `tailscale serve`.
Tailscale's free plan works for a tailnet within its limits. On the board's
machine, use the same unlinked directory and clean environment as above.
Replace `box.tailnet.ts.net` with that machine's tailnet name:

```bash
(
  umask 077
  mkdir -p "$HOME/.local/share/board" && cd "$HOME/.local/share/board" &&
  unset VERCEL VERCEL_PROJECT_ID VERCEL_ORG_ID &&
  vb serve --dir "$HOME/.local/share/board/data" --port 4100 --tailscale box.tailnet.ts.net
)
```

Run the proxy in a second terminal on that machine:

```bash
tailscale serve --bg 4100
```

This is a separate mode. Stop the team-token server first. Don't pass
`--team-tokens`, `--host`, or `--allow-host` here. Teammates use the HTTPS URL
with no `BOARD_TOKEN`: Tailscale names them as `tailscale:user:<login>`. The
board still signs a local token for the operator on its own machine. The page
at the tailnet hostname acts as the visitor. The log keeps its old identities;
a different sign-in does not transfer authorship or task ownership. See
[Share a local board on a tailnet](08-tailnet.md) for setup and who it lets in.

Visitors cannot answer task attention by default. A visitor listed with
`--responder tailscale:user:<login>` can answer if they have `read` and `post`
access on the channel. See [Choose who can answer task attention](../04-reference/01-cli.md#choose-who-can-answer-task-attention).

## Back up and upgrade

Stop `vb serve` before copying or restoring data. Back up the whole `--dir`,
not just `local.db`. That includes `local/` and any SQLite sidecar files.
Keep the backup private and store a copy on a separate disk. Keep the token
file separate, in your secret store. Don't put it in the data archive.

```bash
(
  umask 077
  backup=$(mktemp -d "$HOME/.local/share/board-backup.XXXXXXXX") &&
    tar -czf "$backup/data.tar.gz" -C "$HOME/.local/share/board" data &&
    printf 'backup  %s\n' "$backup/data.tar.gz"
)
```

Install the newer build while the board is stopped. For a global npm install:

```bash
npm update -g @vercel/board
```

Start it again with the same flags and data directory. Check `vb whoami` and
`vb tasks self-host --state completed` from a teammate's machine. For a restore
or rollback, stop the board, move the current data directory aside, and unpack
a trusted backup in its place. Use the build that made the backup if rolling back.

```bash
read -r -p 'Backup archive path: ' archive
saved=$(mktemp -d "$HOME/.local/share/board-before-restore.XXXXXXXX") &&
  test -r "$archive" &&
  mv "$HOME/.local/share/board/data" "$saved/" &&
  tar -xzf "$archive" -C "$HOME/.local/share/board"
```

Run the same `vb serve` command again. The log, tasks, grants, and files survive
restarts. Schedule timers do not. A pending send can still show as due after a
restart without sending. Check and reschedule it if needed.
