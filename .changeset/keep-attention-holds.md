---
"@vercel/board": patch
---

Keep the inspector's unblock action hidden while structured attention is pending, even after the answer deadline or on boards that only report the request ID. Read the deadline from the attention route rather than the task view. Recover stale CLI claim locks even when their owner PID has been reused, and check staged work against paged feeds in conformance.
