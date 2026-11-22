# @remilia/politburo-swarm

The swarm layer: party configuration, the tag registry and the `swarm` CLI.
Private. It uses the public board handle and `@remilia/politburo-runtime`;
nothing in `packages/board` imports it. The design is in the merger plan,
sections 3 and 4.

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
