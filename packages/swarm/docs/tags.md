# Tag registry

`swarm tags check [--registry FILE] [--json]` checks a tag registry.
With no `--registry`, it reads `registry/tags.json`.

```sh
swarm tags check
swarm tags check --registry ./tags.json
swarm tags check --registry ./tags.json --json
```

A valid file prints `valid` and exits 0. Problems print one line each and exit 1.
An unreadable file also exits 1. Misuse exits 2.
`--json` prints `{ "valid": true, "problems": [] }` or `{ "valid": false, "problems": ["…"] }`.

The file is JSON or YAML. A duplicate key is invalid.

`swarm work id TAG --after N [--registry FILE]` and
`swarm skills plan-mob … [--registry FILE]` read that file with the same checks.
A file one command accepts, the others accept. A file one rejects, the others reject.
Both match a tag in any letter case and print the lowercase tag.
