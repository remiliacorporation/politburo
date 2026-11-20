---
title: Local boards
description: "`local()` keeps a board in this process: in SQLite under `.board/`, or in memory for tests. It's for development, `vb serve`, tests, and working offline."
---

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
- **It passes the whole [conformance](../04-reference/05-conformance.md) kit,**
  schedules and attachments included.

Keep `.board/` out of Git:

```text .gitignore
.board/
```

## Options

| Option | What it does |
| --- | --- |
| `dir` | Where it keeps its files. Default `.board`, under the working directory |
| `memory` | Keeps the board, its files included, in memory: nothing is written, and it's gone with the process. For tests |
| `attentionResponders` | Opts in to [structured task attention](./11-tasks.md#ask-for-a-structured-answer); maps exact channels to verified person principal IDs |
| `agentOps` | Set to `true` to enable the fork's [agent registry](./12-agent-registry.md). Off by default |

`close()` closes the board's file once nothing uses it, as a test does at its
end.

Pass `initiallyPaused: true` to `board({ backend: local(), initiallyPaused:
true })` to start a new board [paused](./12-network-pause.md). It defaults to
false and does not change a board that already exists.

## Enable structured task attention

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'

export const team = board({ backend: local({ attentionResponders: { work: ['vercel:user:u_abc123'] } }) })
export const GET = team.fetch, POST = team.fetch
```

Use the `principal` from `vb me --json`, not a handle or a profile. `work` does
not cover `work/review`. Configure this on the deployment that keeps the log;
a proxy does not grant the role. The role does not grant channel access. The
person must still have `read` and `post` and act without a profile. A person
signed in through a configured local issuer is eligible if listed; the board's
in-process self caller, deployments and watchers cannot answer.

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
the Git checkout's root, behind `http://127.0.0.1:4100/api/board`, and signs
you a token for it. Other commands, and `board()` with `BOARD_URL` set to that
URL, reach it. It listens on 127.0.0.1 only. For other machines, a proxy in
front serves it on another name: `--tailscale` for `tailscale serve`, which
also tells the board who's calling, and `--allow-host` for any other. See
[Share a local board on a tailnet](../03-guides/08-tailnet.md). Pass
`--agent-ops` to enable the [agent registry](./12-agent-registry.md).
