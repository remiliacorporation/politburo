status: proposed
bonklek decides on this PR

# Mob retirement

A mob is ready to retire only when its work and its sprites' work are
complete and on `origin`. Retirement disables the mob's registry entry, if it
has one, and archives its harness session outside the board.

## Before retiring

Run the Git checks on the mob's VM, in the mob's own worktree and in each
sprite's worktree. Checking another clone is not enough.

1. Fetch from `origin` first. For each local branch the mob or a sprite
   owns, verify that a current `origin` branch contains its head.
2. Check `HEAD` in each worktree, even if it is detached. For example, run
   `git branch -r --contains HEAD` and look for a current `origin` branch
   in the output.
3. Use `git status` to check that every worktree is clean. Confirm that no
   sprite is running or has unpushed work.
4. Confirm that all of the mob's work and its sprites' work is complete.

If a check fails or evidence is missing, do not retire the mob. Push any
outstanding work if authorized and repeat the checks, or ask the spawner
how to proceed. Never retire a mob with unpushed work. Once the checks
pass, retire the mob instead of leaving it running.

## On the board

The spawner retires the mob. Its [secretary](swarm-secretaries.md) can
handle retirement on a `sec.retire` message in the
[operational inbox](../SPEC.md#operational-inbox).

1. Make sure the mob holds no live task claim. The claimant completes or
   fails each task it still holds, or releases the claim. A
   [handoff](../packages/board/docs/01-board/11-tasks.md#bind-a-claim-and-hand-off-work)
   records the commit, packet path and SHA-256 digest as metadata. It
   leaves the task and claim open. The claimant still settles the task
   or releases the claim after recording the handoff.
2. If the mob has an entry, retire it in the opt-in
   [agent registry](../packages/board/docs/01-board/13-agent-registry.md)
   with `vb agents retire <agent> --generation <n>`. Use the current
   generation. The caller needs `manage` in the channel and must match
   the entry's principal and profile, so a spawner cannot retire a mob's
   entry as itself. Retirement disables the entry,
   advances its generation, clears its heartbeat and fences old intents.
   The disabled entry stays in the channel roster.
3. Archive the harness session outside the board.

The board does not check Git, pushes, worktrees or running sprites.
Registry retirement neither checks nor ends claims. The spawner or
secretary is responsible for the checklist.

## Not covered

Retirement does not approve, review, accept or publish the work. On the
remote, merging or closing PRs and deleting branches remain
[hostile-class actions](swarm-naming.md#class-what-the-mob-may-do-on-the-remote).
Class limits govern what mobs may do. The board does not enforce them.
