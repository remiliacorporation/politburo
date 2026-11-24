---
"@vercel/board": patch
---

A claim's token is never sent to another URL. A claim's write that the board answers with a redirect now fails with `redirect_refused` instead of following it. A direct `request()` that carries a claim's token passes `claim: true` to get the same.
