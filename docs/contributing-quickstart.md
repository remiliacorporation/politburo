---
title: Contributor quickstart
description: How a person sets up a party, claims work on the board, and reviews a PR, without swarm agent tooling.
---

## Start here

This page is for a person who wants to land a patch on `main` the same day.
You use git, `pnpm`, `vb`, and the inspector. You do not need the swarm agent
loop, a mob, or a sprite.

Read [the swarm overview](../design/swarm-overview.md) for what the swarm
layer is and what is on `main`. Then pick a small item from
[starter items](./starter-items.md). [Contributing](../CONTRIBUTING.md) is
the package layout and the PR rules.

[LOCAL-DEVELOPMENT.md](../LOCAL-DEVELOPMENT.md) is a longer local task
handoff. This page is the shorter path for a human claim.

These pages are not on `main` yet: `docs/walkthrough.md`,
`docs/extension-points.md`.

## Install this checkout

Node 22.18 or later, and the pnpm version in the root `package.json`. From
the checkout root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @vercel/board build
```

`vb` in the samples below is this checkout's CLI:

```bash
vb() { node packages/board/dist/cli.mjs "$@"; }
```

## Set up a party

A party is one person's swarm: its name, colour, claim length, and review
rules. The schema and defaults live in `packages/swarm`. You write only the
keys you change. The loader merges them onto
[`packages/swarm/src/config/defaults.json`](../packages/swarm/src/config/defaults.json).

Copy the human overlay, or edit it in place:

[`packages/swarm/examples/human-party.yaml`](../packages/swarm/examples/human-party.yaml)

```yaml
party:
  id: humans
  name: Human contributors
  colour: "#245c3d"
labels:
  core: Chair
  mob_view: Claim
claims:
  hours: 4
  open_claims_per_repo: 1
  uncommitted_claims_per_repo: 1
review:
  docs_only:
    model_review: false
```

`party.id` is lowercase and stable. It is not a person's name. Validate it
against the party schema:

```bash
node packages/swarm/src/cli.ts config validate --party packages/swarm/examples/human-party.yaml
```

```text
valid
```

A bad key prints the dotted path and exits 1:

```bash
printf '%s\n' 'claims:' '  houres: 1' > /tmp/bad-party.yaml
node packages/swarm/src/cli.ts config validate --party /tmp/bad-party.yaml
```

```text
error: claims.houres: must NOT have additional properties
```

You do not need `swarm` after this. The overlay is how you record your party.
Wiring those keys into claims and the work page is still open work; see
[starter items](./starter-items.md).

The full tree and who may edit it are in
[party config](../design/swarm-party-config.md).

## Run a local work board

Keep the board's log and the CLI login out of the checkout. Pick one
directory and reuse it in every terminal. Use an unused port if 4180 is
taken.

```bash
umask 077
export BOARD_DEMO_DIR="${TMPDIR:-/tmp}/politburo-demo"
export XDG_CONFIG_HOME="$BOARD_DEMO_DIR/config"
mkdir -p "$XDG_CONFIG_HOME" "$BOARD_DEMO_DIR/data"
node packages/board/dist/cli.mjs serve --swarm --port 4180 --dir "$BOARD_DEMO_DIR/data" --no-open
```

```text
serving a local board at http://127.0.0.1:4180/api/board as local:user:ubuntu, its log in /tmp/politburo-demo/data  (Ctrl-C to stop)
reach it with --url http://127.0.0.1:4180/api/board, or BOARD_URL=http://127.0.0.1:4180/api/board
inspector at http://127.0.0.1:4180
```

The handle is your OS user.

Leave that terminal open. In a second terminal at the checkout root:

```bash
umask 077
export BOARD_DEMO_DIR="${TMPDIR:-/tmp}/politburo-demo"
export XDG_CONFIG_HOME="$BOARD_DEMO_DIR/config"
unset BOARD_NAME BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR
export BOARD_URL=http://127.0.0.1:4180/api/board
vb() { node packages/board/dist/cli.mjs "$@"; }
vb whoami
```

```text
ubuntu (local:user:ubuntu)
board   http://127.0.0.1:4180/api/board
source  vb serve
token   expires in 720h 0m
```

`vb serve` already serves the inspector. `vb inspect --no-open` is the same
page on a board you already have:

```bash
vb inspect --no-open --port 4747
```

```text
inspecting http://127.0.0.1:4180/api/board as ubuntu at http://127.0.0.1:4747  (Ctrl-C to stop)
```

Open `/work` on the inspector URL. The Work link in the sidebar is that
page. Details of the page are in the
[inspector guide](../packages/board/docs/03-guides/02-inspector.md#what-you-can-do).

On an empty board the queue says `nothing on the board`. Add
`?swarm=fixtures` only to preview seeded rows. Those rows are not live data.

## Claim and finish a work item

The `/work` page groups tasks by who acts next. It does not claim, release,
or complete. Write keys `c`, `x`, `r`, and `d` are unbound
(`packages/board/src/inspect/app/work-view.tsx` line 443). The thread pane parks,
blocks, and assigns. Claim, renew, release, complete, and fail stay on `vb`
([inspector tasks](../packages/board/docs/03-guides/02-inspector.md#tasks),
[task CLI](../packages/board/docs/04-reference/01-cli.md#tasks)).

Create a ready task, then find it on `/work` under Ready to pull. Open the
thread with Enter, or peek with Space.

```bash
id=$(vb tasks create work 'Trim a CLI line that uses a colon.' --no-sync)
vb tasks
```

```text
#2  ready      Trim a CLI line that uses a colon.
```

This run printed `2`. Use the ID `create` prints.

On `/work`, keys: `j` and `k` move, Enter opens the thread, Space peeks,
`/` filters, `g` then `w` jumps to Ready to pull, `?` lists them.

Claim as yourself, not as an agent profile. The default lease is 15 minutes.
`--lease` takes 30s to 1h. Party `claims.hours` is 4 and is not read yet.

```bash
vb tasks claim "$id"
```

```text
#2  yours for 15m  Trim a CLI line that uses a colon.
```

The row moves to Running. Do the work in git. Reply on the thread if you
want a log. Complete with a one-line result:

```bash
vb tasks complete "$id" 'opened a PR against main'
```

```text
completed 2
```

The row moves to Done. `vb tasks release "$id"` gives it back if you stop
early. See [Tasks](../packages/board/docs/01-board/11-tasks.md).

Look at open PRs for the directory you touch, and say in your PR what you
are taking ([swarm overview](../design/swarm-overview.md#where-to-begin)).

## When a PR needs review

Open `/work?view=review`, or press `g` then `r` for Ready to review. Peek
the row and press `p` to open its PR when the page has a link.

Review on GitHub. This fork's docs-only rule is in the party tree
(`review.docs_only.model_review: false` in
[`defaults.json`](../packages/swarm/src/config/defaults.json)): CI on the
exact head, and the docs link check. No model review. The status a PR needs
is the `check` job in `.github/workflows/check.yml` (`pnpm check`).

Title and body follow [AGENTS.md](../AGENTS.md#pr-titles-and-descriptions).
Every PR targets `main`. No stacked branches.

Stop `serve` and `inspect` with Ctrl-C. Then remove the temporary directory
(`rm -rf -- "$BOARD_DEMO_DIR"`).
