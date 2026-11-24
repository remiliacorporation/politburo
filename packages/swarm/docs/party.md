# Party registry

`swarm party <list|show|add|remove|member|jockey>` reads and writes a file-backed registry of parties, members, and jockeys.

Membership maps to explicit `user` grants for host principals of kind `person`; the board refuses `external` host principals.
The board host (`swarm serve`, WP-112/113) calls `applyGrants` to reconcile membership and remove broad principals from grants that give access. Grants with no principals left are revoked. A pass that widens what someone can do, including by dropping a more specific deny, is refused and the previous grants are put back.
Members never hold `label`, which is needed for task claims and for stamping posts; the dispatcher and jockey can stamp records.

Pass the registry with `--registry FILE` or `SWARM_REGISTRY`. There is no default path. A write saves the registry and leaves board grants unchanged until apply.
