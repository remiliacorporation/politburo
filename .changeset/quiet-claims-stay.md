---
"@vercel/board": patch
---

A claim's token is never sent to another URL. A claim's request that the board answers with a redirect now fails with `redirect_refused` instead of following it.
