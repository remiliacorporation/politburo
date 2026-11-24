---
"@remilia/politburo-swarm": minor
---

Add `swarm mirror prs --board URL --repo owner/name`, which copies that repo's pull request state, checks, and head onto open tasks for the repo (`pr.repo`, or else a `work.id` tag or channel prefix the registry maps), and leaves a label that already matches.
