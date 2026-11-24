# Swarm layer: start here

This page is the entry point for anyone about to work on `packages/swarm`. It says what
the swarm layer is, what is on `main` today, which rulings came after the other design
notes were written, and where to begin. It describes `main` at `be34f98f` (2026-11-23).
Where this page and the code disagree, the code wins: fix this page.

## What it is

Politburo is a fork of board. board stores and enforces: threads, messages, tasks,
claims, grants, schedules, the `vb` CLI and the inspector UI. The swarm layer is a client
of board that adds how a swarm of agents is run on it.

| Package | Holds | Rule |
| --- | --- | --- |
| `packages/board` | `@vercel/board`, kept close to upstream | Imports nothing from the other two. Only general, server-enforced features go here. |
| `packages/runtime` | Runs one board task in a harness | A library. |
| `packages/swarm` | Party config, mail, secretary, trackers, mirror, checks, watch, sprite tools, skills. CLI: `swarm` | Uses the public `board()` handle and the runtime only. Never board internals. |

One vocabulary runs through the code and the UI:

| Term | Meaning |
| --- | --- |
| Jockey | A person who runs a swarm. |
| Party | One jockey's swarm: its config, names, colours and score. |
| Core (Party Chairman) | The session that starts and steers a party's spawners. |
| Spawner | One session per repo. Turns requests into work and reads mob reports. |
| Secretary | Routes a spawner's mail so the spawner spends few tokens. Code first, a classifier second, a model last. |
| Mob | A cloud session that plans one work item and starts sprites. |
| Sprite | A `pi` agent that does the work inside the mob's machine. |
| Party board (Standing Committee) | One board per party: its spawners and mail. |
| Repo board (work board) | One board per repo, shared by every party that works on it. |
| Presidium, Cell | A party's view of one repo, and the view of one mob. |

## Rulings that came after the design notes

The notes in this directory are dated 2026-11-22 and carry `status: proposed`. They cite
"the plan", which is not in this repository. These later rulings override them.

1. **Use board's own features first.** Before the swarm layer builds a mechanism, check
   whether board has it, and use it through `board()`. Adopted: watchers, schedules,
   `wait` and `tail` in place of polling loops; task dependencies for work order; schemas
   for the mail header and dispatch envelope; one profile per mob and sprite, so `by` is
   the attribution; `board()` middleware as the one place that enforces spend limits and
   the claim rule; board task commands (`claim`, `renew`, `complete`) as the way agents
   take work; the inspector's data layer (`app/board.ts`, `app/store.ts`) under every
   swarm view. Under review: GitHub sync for the PR mirror, claim tokens, grants per tier.
   Rejected: Slack as the jockey's channel.
2. **Much of the layer predates ruling 1** and rebuilds these by hand: `src/watch`,
   `src/watcher`, `src/mirror`, `src/mail/message.ts`. Expect them to shrink. Ask before
   extending them.
3. **A claim lasts four hours**, and that is the board lease's length. The outcomes a
   claim may end in are listed in the work item. A claim that ends with none of them is
   released, the party is docked, and it may not reclaim for 15 minutes.
4. **Access.** Board invites and grants over the office network or an SSH port-forward
   always work. Cloudflare's free tier may sit in front (`src/identity`); nothing may
   need a paid domain or a card.
5. **Spend.** Every dispatch carries one envelope (party, repo, work id, attempt, tier,
   parent, session, trace). Spend that cannot be measured is recorded as unknown, never
   guessed. Cloud mob spend is unknown today.
6. **Party config is the place for anything a jockey would change:** labels, name pools,
   tiers and models, mail routing, claim numbers, review rules, limits, trackers. A value
   fixed in code that belongs to one person's setup is a defect.
7. **Do not assume a contributor uses the swarm.** Work arrives from people on plain git
   and GitHub, and the mirror and the work board must show it.
8. **No permanent test bulk.** A test earns its place by failing when the behavior
   breaks. `parity/` holds temporary cases copied from the system this layer replaces;
   it is deleted when the cutover is done.
9. **Every PR targets `main`.** No stacked branches.

## What is on main

```bash
node packages/swarm/src/cli.ts config validate
```

```text
valid
```

`swarm config show` prints the merged config tree. `--party FILE` and `--repo FILE` layer
a party's and a repo's values over `src/config/defaults.json`. `swarm check` and
`swarm watch` import the runtime, so run `pnpm build` first.

| Directory | Holds | State |
| --- | --- | --- |
| `src/config` | Schema, defaults, loader. `swarm config show`, `validate` | Works. Most keys are not yet read by other code. |
| `src/skills`, `skills/` | Agent skills generated from the party config. `swarm skills sync` | Works. The one reader of party config. |
| `src/tags.ts`, `registry/tags.json` | The repo tag registry. `swarm tags check`, `swarm work id`, and `swarm skills plan-mob` read it unless `--registry FILE` is set | Works. The shipped list is one jockey's repos. |
| `src/trackers` | Read-only GitHub Issues and Linear adapters, work-item merge. `swarm trackers scan` | Works. No beads adapter. |
| `src/mirror` | Every PR, branch and issue of a repo mirrored to its board | Library only. No CLI on main. |
| `src/mail` | Message contract, inbox, relay between boards, send | Library only. Stricter than the file mail it replaces. |
| `src/classifier` | The packet compiled for the adviser model, and its audit | Library only. No classifier call on main. |
| `src/identity` | Cloudflare Access assertions mapped to board people | Library only. No domain configured. |
| `src/lifecycle` | Stages, evidence gate, action journal, launch recovery | Shadow or off. |
| `src/capture` | Spend record types and the ledger writer | Library only. |
| `src/checks` | Check lock, check-and-push, retire check. `swarm check` | Works. Needs GitHub. |
| `src/watch`, `src/watcher` | Stall, slowdown and PR alerts; the status loop | Shadow. Needs GitHub. |
| `sprite/` | `pi` helpers and the model router | Linux only (`setsid`, `/proc`). The model order is one jockey's accounts. |
| `parity/` | Temporary parity cases | Deleted after cutover. |

Reviewed and merged, but into branches that have not reached `main`: the work board UI
(`/work`, its filters, the three scopes), the mail file bridge, the cutover tool and its
rollback fix, the mirror CLI and overlap check, the sprite supervisor, spend capture from
sprite logs, and the score command. Do not build on them until each lands.

Not built: the secretary service beyond drafts, the classifier questions, the claim rule,
the spend limits, the beads adapter, a local walkthrough, a party config reference.

## Where to begin

1. Read [the merger design](swarm-merger.md) for the package boundary and the two kinds
   of board, then [party config](swarm-party-config.md) and
   [work items](swarm-work-items.md). Read the others when you touch their area:
   [mail](swarm-mail.md), [secretaries](swarm-secretaries.md), [spend](swarm-spend.md),
   [lifecycle](swarm-lifecycle.md), [frontend](swarm-frontend.md),
   [board additions](swarm-board-additions.md), [reuse](swarm-reuse.md),
   [the host runbook](host-runbook.md). [Architecture](swarm-architecture.md) is the
   oldest and is partly replaced; its tier and authority text stands.
2. Run a local board with [LOCAL-DEVELOPMENT.md](../LOCAL-DEVELOPMENT.md). It needs no
   swarm services.
3. Pick work that touches one directory. Good first areas: wire a config key to the code
   that should read it; replace a hand-built mechanism with board's own (ruling 1); move a
   value fixed to one setup into party config (ruling 6).
4. Follow [AGENTS.md](../AGENTS.md) for PR titles, descriptions and tests. Tests for the
   swarm package: `pnpm --filter @remilia/politburo-swarm test`.

Agents are working in this repo. Before you start, look at the open PRs for the directory
you chose, and say in your PR or issue what you are taking.
