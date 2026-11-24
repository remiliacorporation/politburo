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
