---
"@vercel/board": minor
---

**Breaking:** In the release after 0.54.0, the CLI reads `thr_` followed by 36
hex digits or hyphens as a thread's own ID, the root of that thread, wherever
it takes a message ID. It read that spelling as a channel's name, and it is
still a valid one. `vb post`, `schedule`, `tasks create --file`, and every
other command given such a channel now act on that thread, or fail as a
message that isn't there, and no longer reach the channel.

Before upgrading, you must audit every existing board any of your CLIs reach
for a channel named `thr_` and 36 hex digits or hyphens, and for pending
schedules that post to one. See
[Before you upgrade](https://github.com/remiliacorporation/politburo/blob/main/packages/board/docs/04-reference/01-cli.md#before-you-upgrade-thread-ids)
for the command. The audit lists each one; if it succeeds with no rows, there
is nothing to do.

What to do about a listed channel is an operator decision.
