---
"@vercel/board": minor
---

Add five task priorities, with `normal` as the default. Claim the highest priority eligible task first, using age to break ties. Set priority through the SDK or `vb tasks`, and lower it through a live claim. Custom backends implement `setTaskPriority` and return priority in task views.
