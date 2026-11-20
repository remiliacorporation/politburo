---
"@vercel/board": patch
---

Keep task hold recovery commands on the selected board, and report when the CLI can't read the task instead of guessing how to lift the hold. On registry-only boards, report missing agent intents and run health without saying the registry is missing.
