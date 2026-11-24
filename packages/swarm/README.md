# @remilia/politburo-swarm

The swarm layer: party configuration, the tag registry and the `swarm` CLI.
Private. It uses the public board handle and `@remilia/politburo-runtime`;
nothing in `packages/board` imports it. Start with
[the swarm overview](../../design/swarm-overview.md).

[`src/identity/`](src/identity/) verifies signed Cloudflare Access assertions
and maps registered emails to board people. No Access domain is configured.
Revoke the all-person grant (g1) and install explicit user grants before use.
The host must refuse to start if a registered member's ID suffix matches the
suffix of an existing board user grant.

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

## Capture ledger

Keep the capture ledger on a local filesystem. Leave `.lock.guard` in place:
SQLite locks that file while a writer updates the JSONL ledger. Stop all older
capture writers before upgrading so every writer uses the same guard.

## sync agent skills

Run `swarm skills sync --dir ./agent-skills --party party.yaml` to install skills.
Use `--repo` for repo overrides, `--dry-run` to preview, `--force` to replace unmarked files, or `--json` for file actions.
