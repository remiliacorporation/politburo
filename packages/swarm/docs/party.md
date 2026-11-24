# Parties

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

`swarm party <list|show|add|remove|member|jockey>` reads and writes that file.
Pass it with `--registry FILE` or `SWARM_REGISTRY`. There is no default path.
A write saves the registry and leaves board grants unchanged until apply.
