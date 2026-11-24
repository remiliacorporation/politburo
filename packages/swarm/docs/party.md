# Party registry

`swarm party <list|show|add|remove|member|jockey>` reads and writes a file-backed registry of parties, members, and jockeys.

Pass the registry with `--registry FILE` or `SWARM_REGISTRY`. There is no default path. A write saves the registry and leaves board grants unchanged until apply.
