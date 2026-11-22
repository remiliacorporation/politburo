# Deterministic board simulations

```sh
DST_SEEDS=300 pnpm --filter @vercel/board exec vitest run test/dst
DST_EXPECT=e1 DST_SEED=0 pnpm --filter @vercel/board exec vitest run test/dst/e1-lease.test.ts
```

E1 runs seeds 0–199 by default; other experiments default to 0–99.
`DST_SEED=<n>` picks just one seed. For a shard, `DST_SEED_START=<n>` sets the
first seed and `DST_SEEDS` sets the count. A failure lists the failing seeds and
invariants, then prints the first failing trace. E1 still advances time at the
append gate; queue waiters are marked blocked so the driver can release the writer. The
mutation and replay tests use fixed seeds.

| Experiment | Default on main | To run on another checkout |
| --- | --- | --- |
| E1: lease deadline and epoch (I1/I2) | Enabled: 200 seeds. | Use `DST_EXPECT=e1` on older checkouts. |
| E2: scoper revocation (I3) | Pending: no staged access fence. | Runs with PR 21 `fd0685f`'s fence. Use `DST_EXPECT=e2` on a staged checkout without the fence. |
| E3: reopen a finished prerequisite (I4) | Pending: no staged reopen. | Runs with PR 21 `fd0685f`. Use `DST_EXPECT=e3` on an earlier staged checkout. |
| E4: saved claim after stale drop (I5) | Pending: no proof-aware file lock. | Runs when the lock from `770eb47` is detected. On PR 21 `fd0685f`, replay with `DST_EXPECT=e4 DST_SEED=243`: the stale drop moves the saved claim to a tombstone and dies before restoring it. |

E4 leaves PID reaping, mixed CLI versions, death while holding a PID lock, and
cleanup failure after committed completion pending as separate cases. Its actors
share one real PID; a simulated crash stops an actor without running cleanup.

Task requests use in-process HTTP, a fresh memory store, a fixed fake `Date`,
and locally signed test identities. Only landed rows reach the history oracles.
The traces omit generated IDs and secrets. Claim files live under a temporary
config directory. This doesn't test real process crashes or disk durability.
