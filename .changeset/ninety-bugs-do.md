---
"@vercel/board": minor
---

Add operator parking, assignment bindings, and immutable task handoffs.

Custom backends: `parkTask`, `unparkTask`, and `handoffTask` are now required on `Backend`, so a backend written against an earlier version must implement them to compile.
