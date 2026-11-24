---
"@vercel/board": patch
---

Serialize local board writes with grant and pause changes. Recheck access before writing and refuse task writes whose claim expires before insertion.
