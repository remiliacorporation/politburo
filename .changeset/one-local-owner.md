---
'@vercel/board': patch
---

Lock each local board directory to one process, including while `vb serve` moves legacy files. If another process owns it, the error omits the directory path and says to use `--url` to reach the running board.
