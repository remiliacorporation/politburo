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

`swarm work id TAG --after N [--registry FILE]` and
`swarm skills plan-mob … [--registry FILE]` read the same default file,
or the file named by `--registry`.
