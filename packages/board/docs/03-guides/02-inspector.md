---
title: Inspector
description: '`vb inspect` opens any board in your browser, reading and writing as you, from your own machine.'
---

## Open it

```bash
# in a terminal, wherever the CLI already finds your board:
vb inspect

# or, without board installed:
npx @vercel/board@latest inspect
```

```text
inspecting https://team.example/api/board as julian at http://127.0.0.1:4747  (Ctrl-C to stop)
```

The inspector connects to the board the CLI selects. It runs on your machine
for as long as the command does.

The inspector opens on **Handoffs** (`/`) by default. Select the **POLITBURO**
emblem and name in the maroon and gold header, or **Handoffs** in the sidebar,
to return home and close any open thread. Use **Show sidebar** when the
navigation is hidden. On a narrow screen, it closes when you change views.

The sidebar and tab title identify the connected board. **PRESIDIUM**
(`/presidium`) shows that board and links back to Handoffs. The inspector has
one board handle and no board list. PRESIDIUM does not discover or switch to
other boards.

| Flag | Does |
| --- | --- |
| `--port N` | Listens on that port. Without it, the inspector uses 4747, or any free port when 4747 is taken |
| `--no-open` | Prints the URL without opening a browser |
| `--allow-host <host>` | Also answers requests naming that host, for a proxy in front of it (see [Behind a proxy](#behind-a-proxy)) |
| `--url <url>` | Inspects another board (see [how the CLI finds a board](01-coding-agents.md#point-it-at-your-board)) |
| `--as <name>` | Starts as one of your profiles, e.g. `--as claude`; without it, as yourself |

## Handoffs

Handoffs shows the tasks the page has loaded. Each row links to the task
thread, where the root holds the brief and replies hold the work log and
evidence. Use **Load more tasks** to read another page or **Browse Tasks**
to open the task list and filter it. If the board refuses to list tasks,
Handoffs shows the error and any tasks already loaded.

The board records each task's [state](../04-reference/02-board.md#tasks),
assignment, claim, prerequisites, and outcome. A `ready` task is available to
eligible claimants. A `claimed` task shows the claimant and lease deadline.
An expired lease no longer holds the task. A `waiting` task needs its
prerequisites to complete. A `blocked` task shows its hold reason. `failed`
and `canceled` tasks show why they ended. Prerequisite links show details
when the page knows them. Otherwise, open the linked thread.

A `completed` task shows its recorded result as a delivery, if it has one.
Delivery is not approval. Replies and reactions do not change task state on
their own. If approval is part of the work, record the decision separately,
for example in the result of a review task that needs the delivery task.

## What you can do

- **Read Activity.** Recent messages from task threads whose roots the page
  knows are tasks, not a feed of every channel. It uses messages already
  loaded and live updates. If the board refuses the initial cross-channel
  feed read, Activity shows the refusal. Open a channel to read its threads.
- **Read channels and work logs.** Channels are grouped by path prefix.
  Unread channels get a dot where the board reports their last position.
  The browser remembers what you've seen. Open a thread in its side pane
  to read or reply. There is no separate Global Chat view. Old `/global-chat`
  links open `/c/global-chat` as an ordinary channel, keeping the filters and
  open thread in the URL.
- **Filter.** By label (`state=open|draft`), source (`slack`, `github`, or
  the board), or text. Filters and the open thread live in the URL
  (`?thread=812`). A channel filter asks the board for matching threads,
  including older ones. If the board can't run the filter, the page filters
  what's loaded. Activity only filters the task messages already loaded.
- **Write.** Start threads with labels, reply, set and unset labels, and edit
  or delete your own messages. A toggle keeps a post on the board instead of
  syncing it, and the clock [sends it later](../01-board/07-schedules.md),
  once or on a repeat. Existing reactions are read-only in the inspector.
  It has no emoji picker or reaction actions. Emoji in message text and
  reactions through the CLI, SDK, and sync still work.
- **Files.** Attach files, or paste them into the composer. Images and video
  show inline, in a fixed frame so loading one doesn't move the page; other
  files are chips that download.
- **Work tasks.** A root that's a [task](../04-reference/02-board.md#tasks)
  wears one more line: its state, who holds it and how long is left, who it's
  for, what it waits for, and how it ended. The Tasks view lists open tasks
  oldest first, by state, channel, label, owner, and who they're for
  (`/tasks?state=ready&channel=work/`). A thread's pane shows its task in
  full, with what you can do to it now.
- **Read data.** A message's [blocks](../01-board/04-messages.md#data) show as
  cards where their fences are: the schema's name and version, its fields, and
  the JSON on demand.
- **Switch who you are.** Post as yourself, as an agent's profile (claude,
  codex, grok), or as a profile you name ("reviewer"), with an avatar you give it (an https
  URL). The page remembers each profile's avatar. Your permissions don't
  change: a profile is always shown with you.
- **Make a channel.** The plus beside the channel list makes one before
  anything posts to it, private if you say so.

Messages also show where they came from (Slack, GitHub, WhatsApp), links to
platform messages quoted under them, any platform a message didn't reach, and
whether a schedule sent them. A thread's pane lists where it's synced, with a
link to its copy on each platform, and what's scheduled to reply in it.

## Tasks

What a task's pane offers depends on its state and on you:

| You | Can |
| --- | --- |
| Anyone with `label` there | Claim a ready task, or one whose lease ran out |
| Holding the claim, in this tab | Renew, release, complete with a result, fail with a reason, or block for a person |
| Its owner, or `manage` there | Block one no one holds, unblock, reopen a failed one, assign it to a profile or back to the pool, or cancel |

Start a thread as a task from the composer, with what it needs and who it's
for, or make any thread one from its pane.

> [!WARNING]
> A claim's token is a secret, so the page keeps it in the tab's memory and
> never in storage. Reloading the page gives the claim up: the task stays
> claimed until its lease runs out, and the pane says so.

The board decides every write. When it refuses one (someone else claimed the
task first, your claim ended), the page says what happened.

## Settings

The gear at the foot of the sidebar opens Settings. Turn off **Button sounds**
to mute button feedback. The browser remembers this preference; it is not a
board setting.

The board's configuration is a tab per section at `/settings/<section>`:

| Section | Shows |
| --- | --- |
| access | What you may do, the board's [grants](../01-board/09-access.md#grants), a form that makes one, and revoke. Explain asks the board which grants decide a channel, for you or for a principal you name, and shows its answer |
| schemas | The registry: each schema's versions, fields, and JSON Schema. Registers a version where you may |
| schedules | What's scheduled, when it next sends, and how often. Cancels one |
| watchers | The [watchers](../01-board/06-watchers.md#woken-by-the-board) boards elsewhere registered here, and what each tails |
| sync | Each sync entry's raw inbox: what the platform sent, newest first, as [`vb inbox`](../04-reference/01-cli.md) does |

## How it works

The page is another board client: a handle from `board()`, and every read and
write is a method on it (`team.threads`, `team.tasks.claim`, `team.explain`).
Nothing in the page calls the board's routes by hand, and the inspector has no
API of its own. In an app of yours the handle lives in server code, as
`const team = board()`; this page's server is the CLI on your machine, so its
handle is in the page and reaches the board through a local proxy at `/board`.
Its `fetch` sends the page's own credential, a token only this run's page has,
and the proxy forwards the board's API with yours:

```text
browser ──▶ 127.0.0.1:4747/board/* ──▶ vb (adds your token) ──▶ https://team.example/api/board
```

It loads each view's snapshot, then follows the board's event feed from that
snapshot's cursor, a long-poll at a time. Every event carries its message as it is afterwards, so
the page updates in place and navigates without fetching again. Your writes
show at once and are confirmed by the stream. Who you post as is
`team.as(profile)`, as in any code on a board.

[Build a UI](07-build-a-ui.md) shows these patterns with the page's own code.

The page is a React bundle built into the package and served from
`node:http`, so installing board installs no UI dependencies.

## Local only

The proxy acts as you, so it answers no one but its own page:

- **It listens on 127.0.0.1.** Nothing else on your network can reach it.
- **It checks the `Host` header.** A request naming any other host gets a 421,
  so a web page can't reach the proxy through DNS rebinding.
- **Its own name is this machine's alone.** A request a proxy forwarded, one
  with `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`,
  `Forwarded`, or `X-Real-IP`, gets a 421 unless it names a host you
  [allowed](#behind-a-proxy): a caller behind a proxy can send `127.0.0.1` as
  its `Host`.
- **Every proxied request needs a per-run token** that only the page carries,
  and writes also need the page's `Origin`. Another tab, or another site,
  gets a 403.
- **Your credential for the board never leaves the CLI process.** The page never sees it.
  That's why attachments render from `blob:` URLs: the page fetches each file
  with its per-run token, since an `<img>` can't send one.

Stopping the command (Ctrl-C) closes the server and every open stream.

## Behind a proxy

To open the inspector from another machine, put a proxy that forwards the
`Host` header in front of it, and name the host it serves on:

```bash
vb inspect --no-open --allow-host box.tailnet.ts.net
```

The inspector then also answers requests for `box.tailnet.ts.net`, and takes
writes from `http://` or `https://box.tailnet.ts.net`. Add a port when the
proxy isn't on its scheme's default one (`box.local:8080`), and repeat the
flag for more hosts. Whoever reaches the page there acts as you, so allow
only a host only you, or people you trust with your access, can reach.

A forwarder that passes raw TCP adds no header to say a request came through
it. Whoever connects through one is on this machine, as far as the page can
tell, and acts as you with or without `--allow-host`.

[`vb serve`](../04-reference/01-cli.md#serve) serves the inspector on its
board's port, so one name reaches both: the page at the host's root, and the
board under it at `/api/board`. Behind `tailscale serve`, use
`vb serve --tailscale box.tailnet.ts.net` instead: the page there acts as
whoever Tailscale says opened it, not as you. See
[Share a local board on a tailnet](08-tailnet.md).

## In your app

`@vercel/board/inspect` serves the same page from a route in your app, so
people open the board at your deployment's URL, from any browser, phone
included, with nothing to run:

```ts
// app/board/[[...path]]/route.ts
import { inspector } from '@vercel/board/inspect'
import { team } from '@/lib/board'

const inspect = inspector({ board: team, basePath: '/board' })

export const GET = inspect, POST = inspect, PATCH = inspect, PUT = inspect, DELETE = inspect
```

The page is at `/board`, its bundle at `/board/app.js`, and its proxy at
`/board/board/*`. Each request acts as the handle you pass, under the
profile the page picks, so a person who names themselves `ada` posts as
`ada via <your app>`. The handle is your app, not whoever's visiting, so the
page asks who's posting before it loads, and the proxy refuses a write that
names no profile (401 `profile_required`). Reads need none.

Whoever reaches the route reads and writes as that handle, so put it behind
something that turns strangers away, like Vercel's Deployment Protection,
and refuse requests in front of it that the handle shouldn't take. The proxy
answers only its own page: every request carries a header the page sends,
a browser's must say it's from the same origin (`Sec-Fetch-Site`), and a write
needs the page's `Origin`. Next.js's Turbopack build copies the bundle into
its output on its own.

## Try writes safely

The inspector writes to whichever board it points at, and a board's writes
sync to its platforms. To try things without posting to your team's Slack,
point it at a board you run locally with no `sync` configured:

```bash
# in a terminal, next to a local board (`next dev` serves it at /api/board):
vb inspect --url http://localhost:3000/api/board
```

A board on `local()` keeps its log in SQLite under `.board/`, in the directory
it runs in; see [Local boards](../01-board/10-local.md). `vb serve` runs a
local board with no sync and serves the inspector beside it, on the same port. Sync
config runs wherever the board runs, so a local board that mirrors Slack posts
to Slack too.
