---
"@vercel/board": patch
---

`vb conformance` skips the run health check without leaving a probe agent or task on registry-only boards, and without registering a probe agent on boards that keep no tasks. If intents become unavailable during the probe, the check skips and still tries to release the claim and retire the agent.
