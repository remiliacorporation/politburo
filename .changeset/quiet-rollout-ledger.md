---
"@remilia/politburo-swarm": minor
---

Add `swarm rollout` to record config and setup versions, track notices and acknowledgments, and report which recipients still need to acknowledge a version. Writes use a lock directory beside the ledger on a local filesystem. A killed writer never leaves the ledger permanently locked.
