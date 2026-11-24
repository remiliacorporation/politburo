# @remilia/politburo-swarm

## 1.0.0

### Major Changes

- 6268e59: Configure fallback routes in `tiers.models.sprite.routes` instead of `tiers.models.sprite.model`. Export `PI_FALLBACK_TIERS` using `swarm sprite routes` before launching with the router installed. The sprite launcher defaults to Cursor Grok; select `fallback/codex-cursor` to use the router. The extra Codex account alias and its credential seeding are no longer supported.

### Minor Changes

- 9e0cf64: Add `swarm ledger dispatch`, `append`, and `rollup`. Rollups show known subtotals and unknown counts in text or JSON.
- 29ba6dd: Add `swarm rollout` to record config and setup versions, track notices and acknowledgments, and report which recipients still need to acknowledge a version. The ledger is append-only on a local filesystem. The first record for each key wins; incomplete final lines are recoverable, and corrupt complete records are reported.
- 471107b: Add repo intake with spawner decisions, and local commands to check outcomes contracts and calculate the next work ID.
- fe07cbd: Add `swarm alloc serial` and `swarm alloc name`: mob serials that continue the live `mob-serial.txt` and are never reused, and spawner, secretary, mob species and sprite item names taken from the party config's pools.
- 170973b: Add `swarm mirror sync --repo owner/name`, which mirrors every PR, branch and issue of a repo to the board, and `swarm overlap <work-id> --work FILE`, which lists the live branches, open PRs (drafts included) and open issues a work item links. A partial, stale or missing read reports `partial`, never `clear`.

### Patch Changes

- b0c9945: Build and pin the v11 cloud setup script with `swarm setup build`.
- d5a72ac: Keep live capture ledger writers locked in, recover dead writers without overlapping appends, and release the lock when a write fails.
- Updated dependencies [1b06bf7]
- Updated dependencies [338a899]
- Updated dependencies [3c30e91]
- Updated dependencies [721428a]
- Updated dependencies [5123186]
- Updated dependencies [85314f5]
- Updated dependencies [a8766c2]
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
- Updated dependencies [e9a8523]
- Updated dependencies [0d470c0]
- Updated dependencies [03e9af9]
- Updated dependencies [8636d21]
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
- Updated dependencies [7688a88]
- Updated dependencies [11391db]
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
  - @remilia/politburo-runtime@0.1.0
