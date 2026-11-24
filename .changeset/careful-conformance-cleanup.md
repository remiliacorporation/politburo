---
"@vercel/board": patch
---

`vb conformance` deletes only the messages and tasks it created, and only while they read back as it made them: by the same principal, in the same channel, from the same moment. If the mount is pointed at another board mid-run, a message there with the same ID stays, and the check that made it reports what was left. The run-health check also skips on a mount with no health route (its own 404, or discovery JSON), skips when claiming or releasing the probe task says the board keeps no tasks, and fails when it can't retire its probe agent.
