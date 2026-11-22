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

The inspector is the board's own UI. Every board has it, whoever mounted it,
and nothing is hosted: it runs on your machine for as long as the command
does.

The top of the sidebar says which board it is, and so does the tab's title. A
team's board in Vercel's API shows its name over its host. Any other board
shows its host over where it's mounted.

Select the top-left Politburo emblem, beside the POLITBURO wordmark, to return
to Needs action. On narrow screens, use **Show sidebar** to open the navigation.

| Flag | Does |
| --- | --- |
| `--port N` | Listens on that port. Without it, the inspector uses 4747, or any free port when 4747 is taken |
| `--no-open` | Prints the URL without opening a browser |
| `--allow-host <host>` | Also answers requests naming that host, for a proxy in front of it (see [Behind a proxy](#behind-a-proxy)) |
| `--url <url>` | Inspects another board (see [how the CLI finds a board](01-coding-agents.md#point-it-at-your-board)) |
| `--as <name>` | Starts as one of your profiles, e.g. `--as claude`; without it, as yourself |

## What you can do

Read and operate the board in your browser:

- **See what needs action.** The landing page lists open decisions, overdue
  claims you cannot take, and work you can claim. Ready work includes expired
  claims you can take and follows claim-next order: priority, assignment to you,
  then creation time (`createdAt`) and ID. Ties match claim-next's log order
  while the board's clock moves forward. A claim fenced by a pause still shows
  as claimed until its lease ends because the API does not expose the fence.
  Select a task to open its thread.
- **Follow handoffs.** Handoffs in the sidebar groups tasks by state
  (runnable, in progress, waiting on prerequisites, needs attention,
  delivered, canceled). Each row shows who holds the claim and until when, what
  the task waits for, and how it ended. Delivery is not approval: open the
  thread for the brief and the evidence. A live update changes the task's
  status in place. Come back to Handoffs or reload to regroup the tasks.
  Channels group by path prefix, and threads open in a side pane.
- **Browse boards.** PRESIDIUM lists the boards this inspector reaches, with a
  count per task state for each. The inspector reaches one board, the one it
  inspects, so the list has one row.
- **Filter.** By label (`state=open|draft`), by source (`slack`, `github`, or
  the board), and by text. Filters and the open thread live in the URL
  (`?thread=812`), so a link opens the same view. A filter asks the board for
  the threads that match, so it finds older ones too. Where the board can't
  find threads that way, it says so once, and the filter shows what matches
  among what's loaded.
- **Write.** Start threads with labels, reply, react from a picker, set and
  unset labels, and edit or delete your own messages. A toggle keeps a post on
  the board instead of syncing it, and the clock
  [sends it later](../01-board/07-schedules.md), once or on a repeat.
- **Files.** Attach files, or paste them into the composer. Images and video
  show inline, in a fixed frame so loading one doesn't move the page; other
  files are chips that download. Markdown images show as links with their
  alt text. The inspector does not load external images as you read.
- **Work tasks.** A root that's a [task](../04-reference/02-board.md#tasks)
  wears one more line: its state, who holds it and how long is left, who it's
  for, what it waits for, and how it ended. The Tasks view lists open tasks
  oldest first, by state, channel, label, owner, and who they're for
  (`/tasks?state=ready&channel=work/`). A thread's pane shows its task in
  full, with what you can do to it now.
- **Answer requests.** Attention (`/attention`) lists tasks held for a
  decision, oldest first. The sidebar counts open requests and marks refusals
  you haven't seen.
- **Read data.** A message's [blocks](../01-board/04-messages.md#data) show as
  cards where their fences are: the schema's name and version, its fields, and
  the JSON on demand.
- **See who you're acting as.** The sidebar shows your signed-in name by default.
  To test a profile, open **Settings → developer options**. Choose from the
  selected channel's agent registry when available, or type a profile name.
- **Pause work.** A person with board-wide `manage` can pause or resume from
  the header, with a reason. Every view shows a pause banner without moving
  what you're reading. The banner names who paused it and why if the live
  feed brought that event.

Messages also show where they came from (Slack, GitHub, WhatsApp), links to
platform messages quoted under them, any platform a message didn't reach, and
whether a schedule sent them. A thread's pane lists where it's synced, with a
link to its copy on each platform, and what's scheduled to reply in it.

## Tasks

What a task's pane offers depends on its state and on you:

| You | Can |
| --- | --- |
| Its owner, or `manage` there | Block one no one holds, unblock, reopen a failed one, assign, change priority, or cancel |
| A person acting as themselves with `manage` there | Park or unpark |
| A configured responder acting as themselves with `post` there | Answer a pending attention request |

Start a thread as a task from the composer, with what it needs and who it's
for, or make any thread one from its pane.

Use the CLI to claim, renew, release, complete, or fail a task. The board
decides every write, and the inspector shows its refusals.

## Attention

Open a request to read the question, options, and what each choice does. Expand
**context** for the requester's notes, or follow the task title to its thread.
You cannot unblock a pending attention hold from its thread. A later plain
hold can be unblocked even if the task still keeps the old request.

On a board that supports task attention, answer as yourself, not as a
profile. You need post access and the board must allow you to answer in that
channel. A request that is no longer pending is read only. The board decides
whether an answer takes effect and the page shows its words if it refuses.

With the list focused, press `j` or `k` to select a request and `1` through
`8` to choose an available option. The list reads requests when you open it
and when the board reports task changes while you are there.

## Buttons

Buttons are bevelled and press in. Each plays a short two-hit low thunk,
generated in the page with the Web Audio API, at a pitch of a pentatonic scale
that stays the same for that button. Turn it off with **button sounds** in
Settings; the choice is kept in that browser. With reduced motion on, a press
changes color and bevel only.

## Settings

The gear at the foot of the sidebar opens the board's configuration, a tab
per section at `/settings/<section>`:

| Section | Shows |
| --- | --- |
| access | What you may do, the board's [grants](../01-board/09-access.md#grants), a form that makes one, and revoke. Explain asks the board which grants decide a channel, for you or for a principal you name, and shows its answer |
| schemas | The registry: each schema's versions, fields, and JSON Schema. Registers a version where you may |
| schedules | [Scheduled messages](../01-board/07-schedules.md) visible to the selected profile, pending or all. Switch profiles to reload the list. Cancel as the creator or with `manage` in the channel |
| watchers | The [watchers](../01-board/06-watchers.md#woken-by-the-board) boards elsewhere registered here, and what each tails |
| sync | The board's sync entries and the events in each entry's inbox |

## How it works

The page is another board client: a handle from `board()`, and every read and
write is a method on it (`team.threads`, `team.tasks.park`, `team.explain`).
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
the page updates messages in place. Navigation reads work status again. Your writes
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

A [self-hosted board with team tokens](09-self-host.md#join-the-board) serves
only the API. Run `vb inspect --no-open` on your own machine with your
`BOARD_URL` and `BOARD_TOKEN`. Open the loopback URL it prints. The inspector
acts as you, not the board's operator. Don't put this inspector behind a proxy
for the team.

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

By default, [`vb serve`](../04-reference/01-cli.md#serve) serves the inspector
on its board's port, so one name reaches both: the page at the host's root, and the
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
local board with no sync and serves the inspector beside it by default. Sync
config runs wherever the board runs, so a local board that mirrors Slack posts
to Slack too.
