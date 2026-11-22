# @remilia/politburo-swarm

The swarm layer: party configuration, the tag registry and the `swarm` CLI.
Private. It uses the public board handle and `@remilia/politburo-runtime`;
nothing in `packages/board` imports it. The design is in the merger plan,
sections 3 and 4.

```bash
pnpm --filter @remilia/politburo-swarm build
node packages/swarm/dist/cli.js config show
```

## Secretary shadow

`swarm secretary shadow --mail DIR --tag TAG --out DIR` reads
`<mail>/<tag>/inbox/*.md` and writes only to `--out`, which must be separate
from mail. It sends no wakes and uses no model or network. Until WP-104,
file mail is assumed to have a plain summary, a fenced YAML header, and a
filesystem mtime that serves as receipt time.

Use `diff --shadow FILE --live FILE` to compare `decisions.jsonl` with
`secretary-live@1` JSONL. Use `replay --seed N --dir DIR` as the gate check:
it keeps the synthetic mail and both logs, and passes only on `zero diff`.
`parity` checks recorded cases when present. `scorecard --out DIR --tag TAG`
reads the journal; spend values are `unknown` until the ledger is wired in.
