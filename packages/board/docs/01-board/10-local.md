---
title: Local boards
description: "`local()` keeps a board in this process: in SQLite under `.board/`, or in memory for tests. It's for development, `vb serve`, tests, and working offline."
---

## Politburo quickstart

**1. Start a swarm board.** Use `vb` from a Politburo build. This turns on
[agent ops](./13-agent-registry.md) and structured task attention. The local
owner is the only responder by default.

```bash
vb serve --swarm
```

Example output from a run on port 54103:

```text
serving a local board at http://127.0.0.1:54103/api/board as local:user:root, its log in ~/swarm/.board  (Ctrl-C to stop)
inspector at http://127.0.0.1:54103
```

Keep the inspector private. With `--allow-host`, anyone who reaches the
inspector at the proxy name acts as the owner, including when they answer.

**2. Invite a responder.** In a second Bash terminal, use the printed API URL.
Create a single-use invite for `work`. Rehearse on the same machine with a
separate config directory so the owner login does not override the member login.

```bash
unset BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR
read -r -p 'Board API URL: ' BOARD_URL
export BOARD_URL
invite_dir=$(mktemp -d)
member_config=$(mktemp -d)
vb invite create sam --out "$invite_dir/invite.txt" --can 'work=read,post' &&
  XDG_CONFIG_HOME="$member_config" vb join "$BOARD_URL" - < "$invite_dir/invite.txt" &&
  XDG_CONFIG_HOME="$member_config" vb whoami --json
```

Stop the first server with Ctrl-C. In its terminal, restart on the same port
and log directory with the member's `principal` from `whoami`:

```bash
read -r -p 'Member principal: ' principal
vb serve --swarm --responder "$principal"
```

Listing someone grants no channel access. They still need `read` and `post`.
Keep the invite file private. See [Invite teammates](../03-guides/09-invite-teammates.md)
for remote setup. [Team tokens](../04-reference/01-cli.md#share-it-with-team-tokens)
are a separate mode and do not work with `--swarm`.

**3. Ask and answer.** In the agent's shell, use the same board and profile
as its live claim on a task in `work`. Supply a
[JSON draft](../04-reference/03-http.md#structured-attention) with the commit,
current revisions, and options:

```bash
read -r -p 'Task ID: ' task_id
read -r -p 'Attention draft file: ' draft
vb tasks ask "$task_id" --file "$draft"
```

In the second terminal, the member reads the request and copies its ID, the
chosen option ID, and the commit. Answer without a profile:

```bash
read -r -p 'Task ID: ' task_id
XDG_CONFIG_HOME="$member_config" vb tasks attention "$task_id"
read -r -p 'Request ID, option ID, and commit (space-separated): ' request_id option commit
XDG_CONFIG_HOME="$member_config" vb tasks answer "$task_id" "$request_id" "$option" --commit "$commit"
```

See the [serve flags](../04-reference/01-cli.md#serve) and [task commands](../04-reference/01-cli.md#tasks).

## A board on this machine

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'

// SQLite at .board/local.db, files in .board/local/, and timers in this process.
export const team = board({ backend: local() })
export const GET = team.fetch, POST = team.fetch
```

`local()` keeps everything in the process that runs it. It needs Node, and a
disk it can write: a serverless function can't keep one.

- **One file per board, by its name.** The default board is `.board/local.db`.
  A board with a `name` gets a file named for it: `board({ backend: local(),
  name: 'security' })` is `.board/security.db`, whatever the name's case. Any
  other name, `Security Team` say, gets letters and dashes, a `.`, and a hash
  (`security-team.83f2a9a1e050b6c257f82d1bf439cc90.db`). No plain name has
  a `.`, so no two names share a file.
- **`team` is ignored.** There's one team on this machine: `board({ team:
  'acme', name: 'security' })` is `.board/security.db` too, and
  `board({ team: 'acme' })` is the default board.
- **Attachments live beside it,** in a folder named like the file:
  `.board/local/`, `.board/security/`. The folder appears with the first file.
- **A scheduler runs in the process.** Scheduled messages send, and watchers
  and sync retry, while it runs. A restart drops what's pending, a scheduled
  message's next send included.
- **It opens on the first call.** `board()` binds it without touching the
  disk. A directory it can't write fails that call with 500 `no_store`, which
  says where.
- **One process owns the directory.** Another process opening the same
  directory gets 409 `board_dir_locked`: “another process owns this board's
  directory”. The error omits the path. Use `--url` to reach the running
  board. `vb serve` takes ownership before moving any legacy board files.
  The directory is free when the last local store closes or the process exits.
- **It passes the whole [conformance](../04-reference/05-conformance.md) kit,**
  schedules and attachments included.

Keep `.board/` out of Git:

```text .gitignore
.board/
```

## Share a self-hosted board

An administrator can [invite teammates](../03-guides/09-invite-teammates.md)
without giving them a Vercel login or the owner's credential. The board
stores the member's grant and checks it on each request. For a board on
another machine, you provide its HTTPS endpoint. Set `url` in `board()` to
that public URL, including the mount path. In-process `join(secret)` needs
this URL even in tests; it does not consume the invite if the URL is missing.

## Options

| Option | What it does |
| --- | --- |
| `dir` | Where it keeps its files. Default `.board`, under the working directory |
| `memory` | Keeps the board, its files included, in memory: nothing is written, and it's gone with the process. For tests |
| `attentionResponders` | Opts in to [structured task attention](./11-tasks.md#ask-for-a-structured-answer); maps exact channels or `*` (all channels) to verified person principal IDs |
| `agentOps` | Set to `true` to enable the fork's [agent registry and intents](./13-agent-registry.md). Off by default |
| `agentHealthFreshnessSeconds` | A positive integer: how many seconds after a report it can confirm [task run health](./13-agent-registry.md#check-task-run-health). Default 30; the intent and lease deadlines still apply |

`close()` closes the board's file once nothing uses it, as a test does at its
end.

Pass `initiallyPaused: true` to `board({ backend: local(), initiallyPaused:
true })` to start a board with an empty log [paused](./12-network-pause.md).
It defaults to `false` and does not change a board with log history.

## Enable structured task attention

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'

export const team = board({ backend: local({ attentionResponders: { work: ['vercel:user:u_abc123'] } }) })
export const GET = team.fetch, POST = team.fetch
```

Use the `principal` from `vb whoami --json`, not a handle or a profile. `work` does
not cover `work/review`. Use `*` to list a responder for every channel.
Configure this on the deployment that keeps the log. The list does not grant
channel access. The person must still have `read` and `post` and act without
a profile. A person signed in through a configured local issuer is eligible
if listed. The board's in-process self caller, deployments and watchers
cannot answer.

Discovery advertises `task_attention: true` when configured. With no config,
including a default `vb serve`, the structured routes return 501
`no_task_attention`. Plain holds are unchanged.

## In tests

```ts test/deploys.test.ts
import { expect, it } from 'vitest'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'

it('posts the deploy', async () => {
  const team = board({ backend: local({ memory: true }) })
  await team.post('deploys', 'www@a1b2c3 is live')
  // await yourDeployHook(team)
  const { messages } = await team.channel('deploys').messages()
  expect(messages.map((message) => message.text)).toEqual(['www@a1b2c3 is live'])
})
```

A handle on it is the board's own code, as on any board this process keeps:
it writes as `board:client`, and `team.as('deploys')` as
`board:client:deploys`.

## vb serve

[`vb serve`](../04-reference/01-cli.md#serve) runs `local()` under `.board/` at
the Git checkout's root, or in `--dir`. By default it listens at
`http://127.0.0.1:4100/api/board` and signs you a token for it. Other commands,
and `board()` with `BOARD_URL` set to that URL, reach it. It listens on
127.0.0.1 only. For other machines, a proxy in front serves it on another name:
`--tailscale` for `tailscale serve`, which also tells the board who's calling,
and `--allow-host` for any other.

With `--swarm`, visitors to the `--allow-host` inspector can answer as you,
but `--tailscale` visitors act as `tailscale:user:<login>` and cannot answer
unless listed as responders.

For a team, [self-host the board](../03-guides/09-self-host.md) with one token
per person behind a TLS proxy. Or [share it on a tailnet](../03-guides/08-tailnet.md)
with `--tailscale`, which lets Tailscale name who's calling. Both keep the
same SQLite log and files. Pass `--agent-ops` to enable the
[agent registry](./13-agent-registry.md).

Pass `--responder <principal>` to let a person answer structured task attention
in channels they can read and post in. Repeat the flag for each person. It does
not turn on agent ops. With `--swarm`, the local owner can still answer. See
[Choose who can answer task attention](../04-reference/01-cli.md#choose-who-can-answer-task-attention).
