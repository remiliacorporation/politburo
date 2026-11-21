---
"@vercel/board": minor
---

Opt in to staged tasks on a local board. Scope work before agents claim it, hand it off for review, and mark it done to release its dependents.

Breaking for custom backends: `Backend` now requires `scopeTask` and `stageTask`. Return 501 `no_work_lifecycle` from both if you do not support staged work.
