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

## Secretary shadow

`swarm secretary shadow --mail DIR --tag TAG --out DIR` reads
`<mail>/<tag>/inbox/*.md` and writes only to `--out`, which must be separate
from mail. It sends no wakes and uses no model or network. Until WP-104,
file mail is assumed to have a plain summary, a fenced YAML header, and a
filesystem mtime that serves as receipt time.

For non-p0 mail with the same sender, ref, class, and `at`, higher urgency
wins. At equal urgency, the later receipt wins by mtime, then filename.
The router logs the losing candidate as `less_urgent_same_at` or
`older_receipt_same_at`, respectively.

Use `diff --shadow FILE --live FILE` to compare `decisions.jsonl` with
`secretary-live@1` JSONL. Use `outcome: "reject"` with a separate string
`reason` on rejected message rows. Notice rows are
`{"type":"notice","file":"bad.md","to":"sender","reason":"bad_class"}`.
Use the inbox filename and `to: null` when no sender claim was parsed.
Shadow journals these notices without sending them. Digest rows list ordered `items` as
`{"id":"…"}` or, for p3, `{"summary":"…"}`. Forward rows declare the expected
`at`, `lane` and `ids` for each p0/p1 batch; no rows means no forwards expected.
Use `replay --seed N --dir DIR` as the gate check:
it keeps the synthetic mail and both logs, and passes only on `zero diff`.
`parity` checks recorded cases when present. `scorecard --out DIR --tag TAG`
reads the journal; spend values are `unknown` until the ledger is wired in.

`swarm cutover rollback <tag> --execute` restores the service if the final
bridge drain is stale and the old loop is confirmed stopped. Add `--allow-stale`
to accept stale files and finish in files mode instead (exit 1, `rolled_back_stale`).

## Capture ledger

Keep the capture ledger on a local filesystem. Leave `.lock.guard` in place:
SQLite locks that file while a writer updates the JSONL ledger. Stop all older
capture writers before upgrading so every writer uses the same guard.

## sync agent skills

Run `swarm skills sync --dir ./agent-skills --party party.yaml` to install skills.
Use `--repo` for repo overrides, `--dry-run` to preview, `--force` to replace unmarked files, or `--json` for file actions.

Run `swarm skills plan-mob --skills ./agent-skills --tag plb --job build --serial 1` to preview a mob and its brief without launching it or writing files.
