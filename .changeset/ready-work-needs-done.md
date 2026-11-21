---
"@vercel/board": patch
---

Keep work with unfinished prerequisites out of the local ready list, even before its expired lease is recorded. Conformance checks staged dependencies in thread reads and the feed, checks scope events across a revocation race, and rejects staged moves that answer `no_access_fence` despite advertising the fence.
