---
"@vercel/board": patch
---

The inspector shows and filters task priorities. Among the loaded rows, it puts tasks in the viewer’s default claim-next order first, then sorts the rest by priority and age. Ties use `createdAt` then ID, matching claim-next while the board’s clock moves forward. A claim fenced by a pause still shows as claimed because the API does not expose the fence. Live changes update membership and content without reordering the rows you’re reading.
