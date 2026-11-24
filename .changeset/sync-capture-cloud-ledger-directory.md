---
"@remilia/politburo-swarm": patch
---

Sync the capture-cloud ledger directory before `serve` accepts claims so a crash cannot lose a newly created ledger entry after acknowledging a claim.
