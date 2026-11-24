---
status: proposed
---

# One instance for every repo

One board and one inspector hold the work of every repo a party maintains.
A person opens one page and sees Politburo, RemiDarkNET, Remilytics, Kagami
and Remilia World together, or one of them, without changing URLs or hosts.

This replaces the "one repo board per repo" row of
[the merger's boards table](swarm-merger.md#boards) and choice 2 of its
[choices made without asking](swarm-merger.md#choices-made-without-asking).
The work-board rules in [work items](swarm-work-items.md) stay; this page
adds a repo dimension to them.

## Why

The inspector reaches one board. The merger's Standing Committee scope is
"one party across all repos", but with a board per repo that scope can only
be built by a page that merges several boards, each with its own token,
feed and grants. Driving the RDN board on the Studio showed the cost: a
board, an inspector and a port per repo, and switching between them by URL.

One board makes every cross-repo view a filter. It keeps one log, one feed,
one set of grants and one backup.

## Layout on the board

A repo is a channel prefix: its registered three-letter tag
([registry](../packages/swarm/registry/tags.json)).

| Channel | Holds |
| --- | --- |
| `<tag>/intake` | Requests from people and other parties for that repo. |
| `<tag>/work/...` | Work items, claims and tracker links. |
| `<tag>/mirror/...` | PR and branch status. |
| `party/<party-id>/{inbox,outbox,mobs,decisions,spend}` | The party's own records, across repos. |
| `config/repos` | The repo list: one JSON message, the latest wins. |

`config/repos` is a list of `{ tag, name, repo }`, for example
`{ "tag": "rdn", "name": "RemiDarkNET", "repo": "remiliacorporation/remidarknet" }`.
A channel whose first segment is not `party`, `config` or a listed tag is
shown under "other".

Grants follow the prefix: a grant on `rdn/*` scopes a person or agent to
RemiDarkNET. Nothing new is needed in the board for that.

A task's repo is its `work.id` tag when it has one (`rdn-81`), else its
channel's first segment.

## The inspector

### Sidebar

From the top:

1. **Needs you**, across all repos, with a count.
2. **Work**, the queue across all repos.
3. **Repos**: one row per listed repo, with its name, tag and three counts
   (needs you, running, ready to pull). A row opens that repo's work; its
   channels fold under it.
4. **Parties**: the Standing Committee for each party.
5. **Activity**: channels outside any repo, and "other".
6. **Settings**, at the foot.

Handoffs, tasks and attention stop being top-level entries. Their content
is in Needs you and Work, filtered.

### Routes

| Path | View |
| --- | --- |
| `/` | Needs you, all repos. |
| `/work` | The queue, all repos. |
| `/r/<tag>` | One repo's work (Presidium for that repo). |
| `/party/<id>` | Standing Committee. |
| `/cell/<actor>` | One mob. |

Channels keep `/c/<path>`: the repo is the path's first segment. `/presidium`,
`/tasks`, `/attention` and `/handoffs` stay, under "views" in the sidebar.

### Rows, filters and home

- Every row shows its repo tag as text, before the work id. Colour is never
  the only cue.
- The filter gains `repo` (one or several tags). Saved views keep it.
- Home groups stay (Needs you, Ready to review, Running now, Health and
  spend). Health gets one row per repo, then per party, then a total.
- With no party records, rows say "no party", not "external", and Health
  says which config is missing and where to add it.

### Bugs this fixes

Found while driving RDN on the Studio:

1. A task blocked for a person (`needs_input` or `awaiting_approval`) is
   classified "waiting", so Needs you misses it. It belongs in Needs you.
2. After a block, the running count and Running now kept the old claim for
   several seconds on the Studio. On a local board the page updates within a
   second, so this is the live feed's delay through the LAN and the inspector's
   proxy, not the page. Not fixed here.
3. Creating a task cannot mark it human-only. The composer gets "ask a
   person", which creates the task and holds it (`needs_input`) right after.

## Out of scope

- Merging several boards in one page.
- Live swarm records (parties, PRs, spend) from the Studio's services. The
  page keeps reading fixtures for those until the dispatcher writes them.
- Per-viewer sign-in on the Studio (WP-113).

## Plan

1. Repo model: `repoOf(task)`, `reposOf(state)` from `config/repos` and
   channels, pure and tested in `store.ts`.
2. Routes and sidebar.
3. Rows, the repo filter and Health per repo.
4. Bugs 1 and 3.
5. Move the Studio's party board records onto the one board and retire the
   second board process.

Each step lands with tests in `packages/board/test`, the inspector checked
with `agent-browser` against `vb serve`, and a screenshot in the PR.
