---
"@remilia/politburo-swarm": minor
---

Add `swarm rollout` to record config and setup versions, track notices and acknowledgments, and report which recipients still need to acknowledge a version. The ledger is append-only on a local filesystem. The first record for each key wins; incomplete final lines are recoverable, and corrupt complete records are reported.
