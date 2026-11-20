---
"@vercel/board": minor
---

Add five task priorities, with `normal` as the default. Claim-next takes the highest priority eligible ready task. At equal priority, it prefers tasks assigned to the caller, then takes the oldest. Set priority through the SDK or `vb tasks`, and lower it through a live claim. Custom backends implement `setTaskPriority` and return priority in task views.
