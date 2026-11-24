---
"@remilia/politburo-swarm": minor
---

Add `swarm mirror prs --board URL --repo owner/name`, which copies each open task's pull request state, checks, and head from GitHub onto `pr.state`, `pr.checks`, and `pr.head`, and leaves a label that already matches.
