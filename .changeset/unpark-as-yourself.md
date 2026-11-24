---
"@vercel/board": patch
---

When `vb` suggests unparking a task, it tells operators to unset `BOARD_PROFILE`
if it's set so they can unpark as themselves.
