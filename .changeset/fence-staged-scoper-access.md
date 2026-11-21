---
"@vercel/board": patch
---

Make staged moves (scope, stage, reopen, assign, needs, cancel) fail if the scoper's grants change while the board decides. A revocation now stops the write and the decision runs again with the new access. A board whose store has no access fence answers 501 `no_access_fence` for these moves and leaves `accessFence` out of discovery. Also keep a satisfied prerequisite whose done root was deleted when a scoper changes other prerequisites, and stop the inspector offering `complete` on a held staged task whose prerequisite reopened.
