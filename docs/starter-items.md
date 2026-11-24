---
title: Starter items
description: Small first patches on main for a human contributor, each verified in the code.
---

## How to use this list

Each item is under about 200 lines. Each names the file and line checked on
`main` at the commit this page landed with. Do not invent work from memory:
open the file and confirm the line still reads that way.

Read [the swarm overview](../design/swarm-overview.md) first. It is on
`main`. `docs/walkthrough.md` and `docs/extension-points.md` are not on
`main` yet. Do not copy those designs into a first patch.

Claim the item on the work board as
[the contributor quickstart](./contributing-quickstart.md) says, and say in
the PR what you are taking. Size is the expected diff, not calendar time.

## Raise the claim lease so `claims.hours` can be 4

**Why it matters.** Party config says a claim lasts 4 hours
(`packages/swarm/src/config/defaults.json` line 90). The swarm overview
repeats that as ruling 3 (`design/swarm-overview.md` lines 52 to 54). The
board's default lease is 15 minutes (`LEASE_DEFAULT_S = 900` in
`packages/board/src/api/routes.ts` line 259). The local cap is 1 hour
(`LEASE_CAP_S = 3600` in `packages/board/src/server/tasks.ts` line 23). The
CLI refuses `--lease` above 1h (`packages/board/src/cli/main.ts` line 2111).
Nothing in `packages/swarm/src` reads `claims.hours` except the loader.

**Files.** `packages/board/src/server/tasks.ts`,
`packages/board/src/cli/main.ts`, `packages/board/src/api/routes.ts`,
`packages/swarm/src/config/defaults.json`.

**How to test.** `vb tasks claim <id> --lease 4h` on a local board. Today it
exits 2 with `--lease takes 30s to 1h`. After the change it prints a claim
that lasts 4 hours. Keep a test that `--lease 5h` still fails if 4h is the
cap.

**Size.** Small. Raising the cap and the CLI check is enough. Reading the
party file from `board()` is a later patch.

## Show party group labels on `/work`

**Why it matters.** The party schema's `labels` object only has `product`,
`core`, `party_board`, `repo_view`, and `mob_view`
(`packages/swarm/src/config/schema.json` lines 17 to 27). The design tree
also requires `party`, `jockey`, `repo_board`, `groups`, and `home`
(`design/swarm-party-config.md` lines 36 to 58 and 163 to 168). `/work`
hardcodes the seven group titles (`packages/board/src/inspect/app/work.ts`
lines 35 to 47) and the four home headings (`work-view.tsx` lines 375 to
394). A party cannot rename "Needs you".

**Files.** `packages/swarm/src/config/schema.json`,
`packages/swarm/src/config/defaults.json`,
`packages/board/src/inspect/app/work.ts`,
`packages/board/src/inspect/app/work-view.tsx`.

**How to test.** Overlay `labels.groups.pull` in a party file, validate it,
and render `/work`. The Ready to pull heading should be the overlay string.
`packages/board/test/work.test.ts` is the in-process check.

**Size.** Small.

## Print `swarm watch diff` as columns

**Why it matters.** CLI design in [AGENTS.md](../AGENTS.md#cli-design-srccli)
says a row is the subject, two spaces, then the value. No colons in that
row. On a match, `swarm watch diff` prints `same alerts: N matched, M extra`
(`packages/swarm/src/watch/cli.ts` line 80). The missing-alert line already
uses columns (`missing  <at> <kind> (script line N)` on line 79).

**Files.** `packages/swarm/src/watch/cli.ts`,
`packages/swarm/test/watch.test.ts` (the extras assertion at line 74 matches
`extra` and does not pin the colon).

**How to test.** Run the existing `watch.test.ts` extras case. Change the
success line to use a colon again and see the test fail. Target:

```text
matched  3
extra  1
```

**Size.** Extra small.

## Shape swarm misuse like board errors

**Why it matters.** Board prints `error: <headline>`, then a blank line, then
each way out two spaces in (`packages/board/src/cli/failure.ts` lines 61 to
83). Swarm `config` prints the usage string on the next line with no blank
line and no indent (`packages/swarm/src/cli.ts` lines 30 to 33). `swarm
capture` concatenates usage onto the error line
(`packages/swarm/src/capture/cli.ts` lines 20 to 22).

**Files.** `packages/swarm/src/cli.ts`, `packages/swarm/src/capture/cli.ts`,
`packages/swarm/src/skills/cli.ts` (same `misuse` pattern at lines 19 to 22),
`packages/swarm/test/cli.test.ts`.

**How to test.** `node packages/swarm/src/cli.ts unknown` and
`node packages/swarm/src/cli.ts capture`. Stderr should be:

```text
error: unknown command unknown

  usage: swarm config <show|validate> [--json] [--party FILE] [--repo FILE]
```

Break the blank line and see `cli.test.ts` fail.

**Size.** Small.

## Fill the skipped E4 drop-after-complete test

**Why it matters.** A skipped test already names the failure:
`E4: claims.drop can throw after complete committed (PR 21 fd0685f); needs a
product fix and a command-level cleanup failure fixture`
(`packages/board/test/dst/e4-claim-files.test.ts` line 414). The product
path is `vb tasks complete` leaving a claim file behind if `claims.drop`
throws.

**Files.** `packages/board/test/dst/e4-claim-files.test.ts`,
`packages/board/src/cli/claims.ts`.

**How to test.** Replace `it.skip` with a command-level fixture that makes
`drop` throw after complete has committed. The test should fail on main
without the product fix, then pass with it. Follow
[test-behavior](../.claude/skills/test-behavior/SKILL.md): break the fix
and see it fail.

**Size.** Medium. Stay under about 200 lines. The other E4 skips on lines
411 to 413 need a multiprocess fixture; leave those.

## Refresh "What is on main" in the swarm overview

**Why it matters.** `design/swarm-overview.md` line 4 pins `main` at
`be34f98f`. Line 91 says the mirror is library only, with no CLI. Line 96
says capture is library only. Lines 102 to 105 say the work board UI,
cutover, and the mirror CLI have not reached `main`. On current `main`:
`packages/swarm/src/cli.ts` lines 5 to 7 list `swarm mirror sync` and
`swarm overlap`; `packages/board/src/inspect/app/routes.ts` line 31 routes
`/work`; `packages/swarm/src/capture/cli.ts` is on the `swarm capture` path
in `packages/swarm/src/cli.ts` line 108.

**Files.** `design/swarm-overview.md`.

**How to test.** For each row in "What is on main", run the command the row
names (`swarm mirror`, `swarm capture`, `swarm cutover`, open `/work`) and
paste the output. Change the SHA in the first sentence to the `main` you
checked.

**Size.** Extra small. Docs only.

## Stop serving fixture swarm records as the work page's data

**Why it matters.** `/work` reads live tasks from the board, then overlays
"swarm records" that are hardcoded fixtures
(`packages/board/src/inspect/app/work-fixtures.ts` lines 1 to 2,
`packages/board/src/inspect/app/board.ts` lines 719 to 720). The page itself
says `swarm records: none (add ?swarm=fixtures to preview seeded fixtures)`
(`work-view.tsx` line 352). `claims.open_claims_per_repo` in
`packages/swarm/src/config/defaults.json` line 93 is unread. The fixture
party uses `openClaimLimit: 4` (`work-fixtures.ts` line 9). Health on
`/work` cannot show a real cap.

**Files.** `packages/board/src/inspect/app/board.ts`,
`packages/board/src/inspect/app/work-fixtures.ts`,
`packages/board/src/inspect/app/work.ts`,
`packages/swarm/src/config/defaults.json`.

**How to test.** Serve a local board, claim two tasks, open `/work` without
`?swarm=fixtures`. Active / limit should follow `claims.open_claims_per_repo`
once you wire it. A test in `packages/board/test/work.test.ts` should fail if
the overlay still prefers the fixture `4` over the config `2`.

**Size.** Medium. Keep fixtures behind `?swarm=fixtures` for screenshots.

## Add paste-complete samples to the naming design

**Why it matters.** [Mob and sprite naming](../design/swarm-naming.md) has
no fenced samples. It has tables for title formats (lines 31 to 38) and no
command that produces a name. `swarm skills plan-mob` already prints `mob`,
`title`, `class`, and `sprite` columns (`packages/swarm/src/skills/cli.ts`
lines 74 to 77). A first-day reader cannot paste their way to a name.

**Files.** `design/swarm-naming.md`, `packages/swarm/src/skills/cli.ts`.

**How to test.** Run the command you add, from a clean checkout, and paste
the real output under it. `pnpm --filter @remilia/politburo-swarm test`
covers `plan-mob` in `packages/swarm/test/skills.test.ts`.

**Size.** Extra small. Docs, plus a transcript. Do not change naming rules.
