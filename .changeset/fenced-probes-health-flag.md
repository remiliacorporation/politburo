---
'@vercel/board': patch
---

Pending run probes whose claim a pause fenced no longer show in `agents.intents`, so a worker never lists one `take` refuses with 409 `claim_lost`. A board advertises command intents and run health with `agent_intents: true` in discovery, apart from `agent_ops`, and a client on `http()` sends those calls only to a board that does, so an older mount's discovery page is never read as health and conformance skips the run health check there. A failed claim on a parked task suggests `unpark`, not `unblock`.
