# @remilia/politburo-runtime

## 0.1.0

### Minor Changes

- 338a899: Add optional runner policies that pause dispatch at 95% of a five-hour usage window and limit concurrent runs by kind and by machine-wide heavy-check slots.
- 3c30e91: Add ops helpers: issue refill as proposed tasks, a privacy scan for diffs, an instance scaffold, and resume packets with an attempt ledger.
- a8766c2: Add `runController` to wake handlers for operational inbox mail, record receipts, and escalate unacted mail to the agent's immediate parent.
- e9a8523: Add replay-safe run harnesses for local fixtures and Pi commands, plus a runner that leases a board task without completing it.
- 8636d21: Exchange remote work files on dedicated Git branches, open draft PRs for finished work, and gate readiness on passing checks and a signed clean verdict for the same commit.
- 4c2c55b: Include the board pause epoch in local task claims. Make the runtime return `paused` and cancel interrupted attempts through the harness, while leaving queue priority to the board.
- 7688a88: Route bounded task attempts by model quality, cost, or latency. Record attempt scores through board and back off on provider failures without settling tasks.
- 11391db: Add the shared name pool, `pickName`, and `spawnerTitle`.

### Patch Changes

- Updated dependencies [1b06bf7]
- Updated dependencies [721428a]
- Updated dependencies [5123186]
- Updated dependencies [85314f5]
- Updated dependencies [d73458d]
- Updated dependencies [5447ac2]
- Updated dependencies [da5258e]
- Updated dependencies [cffd279]
- Updated dependencies [f2e1d7b]
- Updated dependencies [8abee63]
- Updated dependencies [c98c51b]
- Updated dependencies [fe77d31]
- Updated dependencies [f6bcf96]
- Updated dependencies [2186d6f]
- Updated dependencies [7d00d78]
- Updated dependencies [e82261b]
- Updated dependencies [b509531]
- Updated dependencies [b7f2e73]
- Updated dependencies [3f1412a]
- Updated dependencies [3f1412a]
- Updated dependencies [5f2ed85]
- Updated dependencies [5850115]
- Updated dependencies [3f1412a]
- Updated dependencies [2e42015]
- Updated dependencies [2c08681]
- Updated dependencies [ff9b300]
- Updated dependencies [0d470c0]
- Updated dependencies [03e9af9]
- Updated dependencies [a0ad5c7]
- Updated dependencies [4c2c55b]
- Updated dependencies [47867df]
- Updated dependencies [3b09bee]
- Updated dependencies [c04ef2c]
- Updated dependencies [80a1502]
- Updated dependencies [a65cb8b]
- Updated dependencies [94d570b]
- Updated dependencies [3de67b0]
- Updated dependencies [1841881]
- Updated dependencies [f6db189]
- Updated dependencies [9626455]
- Updated dependencies [3f1412a]
- Updated dependencies [ea5dc5b]
- Updated dependencies [bb86c1a]
- Updated dependencies [3035bb8]
- Updated dependencies [c98c51b]
- Updated dependencies [c810570]
- Updated dependencies [b303dde]
- Updated dependencies [2fc0437]
- Updated dependencies [bff12dc]
- Updated dependencies [8a1de3b]
- Updated dependencies [16f5b90]
- Updated dependencies [8435f68]
- Updated dependencies [2fc0437]
- Updated dependencies [2fc0437]
- Updated dependencies [2fc0437]
  - @vercel/board@0.55.0
