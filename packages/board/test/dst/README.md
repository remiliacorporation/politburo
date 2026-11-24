# Deterministic board simulations

```sh
DST_SEEDS=300 pnpm --filter @vercel/board exec vitest run test/dst
DST_EXPECT=e1 DST_SEED=0 pnpm --filter @vercel/board exec vitest run test/dst/e1-lease.test.ts
DST_EXPECT=e2 DST_SEED=10 pnpm --filter @vercel/board exec vitest run test/dst/e2-access.test.ts
```

E1 runs seeds 0–199 and E2 runs seeds 0–49 by default; other experiments default to 0–99.
`DST_SEED=<n>` picks just one seed. For a shard, `DST_SEED_START=<n>` sets the
first seed and `DST_SEEDS` sets the count. A failure lists the failing seeds and
invariants, then prints the first failing trace. E1 still advances time at the
append gate; queue waiters are marked blocked so the driver can release the writer. The
mutation and replay tests use fixed seeds.

| Experiment | Default on main | To run on another checkout |
| --- | --- | --- |
| E1: lease deadline and epoch (I1/I2) | Enabled: 200 seeds. | Use `DST_EXPECT=e1` on older checkouts. |
| E2: write access after grant revocation (I3) | Enabled: 50 seeds with the local writer queue. | Use `DST_EXPECT=e2` to force the experiment on a checkout with the queue seam. |
| E3: reopen a finished prerequisite (I4) | Pending: no staged reopen. | Runs with PR 21 `fd0685f`. Use `DST_EXPECT=e3` on an earlier staged checkout. |
| E4: saved claim after stale drop (I5) | Pending: no proof-aware file lock. | Runs when the lock from `770eb47` is detected. On PR 21 `fd0685f`, replay with `DST_EXPECT=e4 DST_SEED=243`: the stale drop moves the saved claim to a tombstone and dies before restoring it. |

E2 races revoke and pause against post, reply, reaction, edit, delete, label,
channel and task creation, claim, renew, complete, release, fail, schedule creation,
attachment upload, and a sync delivery receipt. It merges committed board, access,
and schedule rows in insertion order. Attachments have no log row, so it watches
bytes and metadata that actually reach the blob store. A 403 or 409 must leave
neither rows nor blobs; no claim may land after pause. Timers are not delivered.

E4 leaves PID reaping, mixed CLI versions, death while holding a PID lock, and
cleanup failure after committed completion pending as separate cases. Its actors
share one real PID; a simulated crash stops an actor without running cleanup.

Task requests use in-process HTTP, a fresh memory store, a fixed fake `Date`,
and locally signed test identities. Only landed rows reach the history oracles.
The traces omit generated IDs and secrets. Claim files live under a temporary
config directory. This doesn't test real process crashes or disk durability.
