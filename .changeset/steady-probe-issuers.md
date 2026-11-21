---
'@vercel/board': patch
---

`agents.intents` omits pending run probes whose issuer no longer has authority
to issue them. Other pending intents are listed as before.
