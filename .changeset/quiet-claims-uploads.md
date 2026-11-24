---
"@vercel/board": patch
---

A file the inspector uploads through a handle on another board is never redirected, and a claim's request answered with a redirect in the Node transport is refused with `redirect_refused` whatever its `Location` is.
