---
"@vercel/board": patch
---

Keep a newer saved task claim when another CLI command settles or loses the old one. Custom `vb()` claim stores must compare the epoch and token passed to `Claims.drop` and remove the claim only if both still match.
