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

## Parties

The registry holds jockey emails and parties with stable IDs, names, colours, and member roles.
Membership maps to explicit `user` grants for host principals of kind `person`; the board refuses `external` host principals.
The board host (`swarm serve`, WP-112/113) calls `applyGrants` to reconcile membership and remove broad principals from grants that give access. Grants with no principals left are revoked.
Members never hold `label`, which is needed for task claims and for stamping posts; the dispatcher and jockey can stamp records.
Use `swarm party` to edit the JSON registry:

```json
{
  "version": 1,
  "jockeys": ["operator@example.com"],
  "parties": [{
    "id": "default",
    "name": "Default Party",
    "colour": "#b3261e",
    "members": [{ "email": "colleague@example.com", "role": "member" }]
  }]
}
```

## Capture ledger

Keep the capture ledger on a local filesystem. Leave `.lock.guard` in place:
SQLite locks that file while a writer updates the JSONL ledger. Stop all older
capture writers before upgrading so every writer uses the same guard.

## sync agent skills

Run `swarm skills sync --dir ./agent-skills --party party.yaml` to install skills.
Use `--repo` for repo overrides, `--dry-run` to preview, `--force` to replace unmarked files, or `--json` for file actions.
