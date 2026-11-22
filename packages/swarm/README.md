# @remilia/politburo-swarm

The swarm layer: party configuration, the tag registry and the `swarm` CLI.
Private. It uses the public board handle and `@remilia/politburo-runtime`;
nothing in `packages/board` imports it. The design is in the merger plan,
sections 3 and 4.

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
