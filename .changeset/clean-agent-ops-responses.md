---
'@vercel/board': patch
---

Strip unknown fields from HTTP agent registry, intent, and health replies. Report `502 remote_error` when a `not_confirmed` health reply carries `validUntil`.
