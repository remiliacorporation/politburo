---
'@vercel/board': patch
---

`vb read <channel>` on a team's default board, with `--scope` and no `--name`, now says that's the board it read when the channel isn't there, and how to read another of the team's boards with `--name`. Its "see its channels" step keeps `--scope`.
