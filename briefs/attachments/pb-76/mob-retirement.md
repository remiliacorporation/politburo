# Mob retirement

Under this user-approved convention, retire (archive) a [mob](taxonomy.md)
only when all of its work and all of its sprites' work is complete and
pushed to `origin`.

## Before retiring

The spawner retires the mob, or its secretary does so in response to a
`sec.retire` message. See [swarm secretaries](swarm-secretaries.md) for routing
and message records in `$SWARM_NOTES_DIR`, a shared notes folder outside the
repo. The board does not retire or launch agents.

Run the Git checks below in the mob's own worktree and in each sprite's own
worktree, on the mob's VM. Checks from another clone alone are not enough.

1. Fetch from `origin` first, then compare local and remote heads for every
   branch the mob or any of its sprites owns. Verify that every local head
   is on `origin`. Check `HEAD` in each worktree too: even a detached `HEAD`
   can hold unpushed commits. For example, use `git branch -r --contains HEAD`
   and verify that a current `origin` branch contains it.
2. Confirm that no sprite is running or has unpushed work. Use `git status`
   to verify that the mob's and sprites' worktrees are clean.
3. Confirm that all of the mob's work and all of its sprites' work is
   complete.

If any check fails or the required evidence is unavailable, do not retire the
mob. Push outstanding work if authorized and recheck, or ask the spawner to
decide how to proceed. Never retire a mob with unpushed work. Never leave a
finished, fully pushed mob running.

## Not covered

Retirement is not approval, review, acceptance or publication. On the remote,
merging or closing pull requests and deleting branches remain
[hostile-class actions](swarm-naming.md#class-what-the-mob-may-do-on-the-remote).
Class limits govern what mobs may do; the board does not enforce them.
