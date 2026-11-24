# Swarm layer: start here

This page is the entry point for anyone about to work on `packages/swarm`. It says what
the swarm layer is, what is on `main` today, which rulings came after the other design
notes were written, and where to begin.
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
   extending them. Claims already moved: `src/claims` is a rule on board tasks and leases.
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

This section describes `main` at `f6110335` (2026-11-24). `swarm --help` is the current
list of commands; trust it over this table.

```bash
node packages/swarm/dist/cli.js config validate
```

```text
valid
```

Build first: `pnpm --filter @remilia/politburo-swarm... build`. Each area has a page in
[`packages/swarm/docs`](../packages/swarm/docs) where one exists; the party config keys are in
[the party config reference](../packages/swarm/docs/party-config-reference.md).

| Directory under `src/` | Holds | Command |
| --- | --- | --- |
| `config` | Schema, defaults, loader. `--party FILE` and `--repo FILE` layer over the defaults | `swarm config` |
| `party` | Party registry, roles, members, jockeys | `swarm party` |
| `tags`, `tags.ts` | The repo tag registry, replaceable with `--registry FILE` | `swarm tags check` |
| `skills` | Agent skills generated from the party config | `swarm skills sync` |
| `sprite` | Sprite tiers and model routes read from party config | `swarm sprite routes` |
| `commands` | One module per `swarm` subcommand, serial and name allocation among them | `swarm alloc` and the rest |
| `work`, `outcomes`, `claims` | Work ids and links, the outcomes contract, the claim rule on board tasks | `swarm work`, `swarm overlap` |
| `trackers` | Read-only GitHub Issues, Linear and beads adapters, work-item merge | `swarm trackers` |
| `mirror` | Every PR, branch and issue of a repo mirrored to its board | `swarm mirror sync` |
| `mail` | Message contract, inbox, relay between boards, the file bridge | `swarm mail send` (not listed by `--help`) |
| `secretary`, `classifier`, `digest` | Model-free routing in shadow, the classifier questions in shadow, notices and the exception digest | `swarm classifier` |
| `cutover`, `rollout` | Moving a mail tag from files to a board and back; the rollout ledger | `swarm cutover` (not listed by `--help`), `swarm rollout` |
| `ledger`, `capture`, `capture-claude`, `capture-cloud`, `usage` | The spend ledger, spend from sprite logs and usage events, the cloud receiver, the usage stop | `swarm ledger`, `swarm capture`, `swarm capture-cloud` |
| `scoring` | Score rules, leaderboard, scorecard, history | `swarm score` |
| `identity` | Cloudflare Access assertions mapped to board people | `swarm serve` |
| `lifecycle` | Stages, evidence gate, action journal, launch recovery | none |
| `gate` | One merge verdict for a PR head, read from the board and GitHub checks | `swarm gate check` |
| `checks`, `watch`, `watcher` | Check lock and check-and-push; stall, slowdown and PR alerts. Need GitHub | `swarm check`, `swarm watch` |

Outside `src/`: `sprite/` holds the `pi` helper scripts (Linux only), `skills/` the skill
sources, `examples/` a party file for people, and `parity/` temporary cases that are
deleted after the cutover. The work board is in the inspector at `/work`
(`packages/board/src/inspect`).

Known gaps:

- **Tests on macOS.** Cases that need Linux (`/proc`, `setsid`) are skipped on a Mac. CI
  runs them on Linux.
- **Shadow means it records what it would do and does nothing.** The secretary, the
  classifier and the watch service are in shadow. No mail tag has moved to a board.
- **One shared board, office network only.** A party board and a repo board run on an
  office host. Ask the repo owner for the address and your own token. The live feed needs
  the office network or an SSH port-forward.
- **The work board reads only.** It has no create, claim or complete controls; use `vb tasks`.

## Where to begin

1. Read [the merger design](swarm-merger.md) for the package boundary and the two kinds
   of board, then [party config](swarm-party-config.md) and
   [work items](swarm-work-items.md). Read the others when you touch their area:
   [mail](swarm-mail.md), [secretaries](swarm-secretaries.md), [spend](swarm-spend.md),
   [lifecycle](swarm-lifecycle.md), [frontend](swarm-frontend.md),
   [board additions](swarm-board-additions.md), [reuse](swarm-reuse.md),
   [the host runbook](host-runbook.md). [Architecture](swarm-architecture.md) is the
   oldest and is partly replaced; its tier and authority text stands.
2. Follow [the walkthrough](../docs/walkthrough.md): a local board, a party file and one
   task from claim to done. Then [the contributor quickstart](../docs/contributing-quickstart.md)
   and [starter items](../docs/starter-items.md). To add a tracker, a classifier question or
   a relay target, read [extension points](../docs/extension-points.md).
3. Pick work that touches one directory. Good first areas: wire a config key to the code
   that should read it; replace a hand-built mechanism with board's own (ruling 1); move a
   value fixed to one setup into party config (ruling 6).
4. Follow [AGENTS.md](../AGENTS.md) for PR titles, descriptions and tests. Tests for the
   swarm package: `pnpm --filter @remilia/politburo-swarm test`.

Agents are working in this repo. Before you start, look at the open PRs for the directory
you chose, and say in your PR or issue what you are taking.
