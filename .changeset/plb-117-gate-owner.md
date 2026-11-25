---
"@remilia/politburo-swarm": patch
---

`swarm gate check` follows the task labelled `pr.number` for that pull request, and skips a task labelled `fix.of` for it, so a completed fix round that names the same pull request is not a second owner.
