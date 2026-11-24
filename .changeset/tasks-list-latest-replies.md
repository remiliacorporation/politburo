---
'@vercel/board': patch
---

On Vercel's board, `tasks.list()` asks for each task's latest reply with the list, so a page of tasks costs one request instead of one more for every task that has replies. On an API that doesn't send them yet, it reads each reply by ID as before.
