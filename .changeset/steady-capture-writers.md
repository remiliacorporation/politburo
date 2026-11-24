---
"@remilia/politburo-swarm": patch
---

Keep live capture ledger writers locked in, recover dead writers without overlapping appends, and release the lock when a write fails.
