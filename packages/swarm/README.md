# @remilia/politburo-swarm

The swarm layer: party configuration, the tag registry and the `swarm` CLI.
Private. It uses the public board handle and `@remilia/politburo-runtime`;
nothing in `packages/board` imports it. The design is in the merger plan,
sections 3 and 4.

```bash
pnpm --filter @remilia/politburo-swarm build
node packages/swarm/dist/cli.js config show
```

## Spend ledger

```sh
swarm ledger dispatch --db ledger.sqlite dispatch.json
swarm ledger append --db ledger.sqlite spend.json
swarm ledger append --db ledger.sqlite bench.json --execution sprite-1
swarm ledger rollup --db ledger.sqlite --level party
swarm ledger rollup --db ledger.sqlite --by repo,tier --repo acme/web --json
swarm ledger rollup --db ledger.sqlite --unmatched
```

`dispatch` and `append` read one JSON object from a file or stdin (omit the
file or use `-`). Bench runs without `--execution` go to the unmatched view.
Rollups require an existing ledger and report unknown counts alongside known
subtotals. See [the ledger design](../../design/swarm-spend.md) for the input
shapes.
