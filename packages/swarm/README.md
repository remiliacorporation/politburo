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

`src/work/` handles work IDs and tracker badges, records explicit or stable-reference links,
and parses and fingerprints v1 acceptable-outcomes contracts. These functions do not
read the board or verify outcome evidence.

Every `Link` requires a nonblank `scope` of at most 512 characters. Use the
repository or workspace that makes the `ref` unique, such as `acme/web` or
`eng-workspace`. Links are deduplicated by `kind`, `source`, `scope`, and `ref`.
A link needs an explicit association or a stable source reference, never a title match.

```bash
pnpm --filter @remilia/politburo-swarm build
node packages/swarm/dist/cli.js config show
```

## Capture ledger

Keep the capture ledger on a local filesystem. Leave `.lock.guard` in place:
SQLite locks that file while a writer updates the JSONL ledger. Stop all older
capture writers before upgrading so every writer uses the same guard.

## sync agent skills

Run `swarm skills sync --dir ./agent-skills --party party.yaml` to install skills.
Use `--repo` for repo overrides, `--dry-run` to preview, `--force` to replace unmarked files, or `--json` for file actions.
