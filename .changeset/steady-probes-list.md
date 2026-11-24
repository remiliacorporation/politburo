---
'@vercel/board': patch
---

`agents.intents` no longer lists a pending run probe whose lease has run out or whose task is gone, so a worker is never listed one `take` refuses. A handle on `http()` throws 502 `remote_error` when an older mount answers an agent call with anything but its response, so discovery is never read as health, and conformance skips the run health check on a board that has no agent intents, even when its discovery was cached. A refused claim on a held task whose hold was lifted since says so and suggests only a read, and the `claim` order is documented as priority, then assigned to the caller, then oldest.
