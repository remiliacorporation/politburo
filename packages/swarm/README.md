# @remilia/politburo-swarm

The swarm layer: party configuration, the tag registry and the `swarm` CLI.
Private. It uses the public board handle and `@remilia/politburo-runtime`;
nothing in `packages/board` imports it. The design is in the merger plan,
sections 3 and 4.

```bash
pnpm --filter @remilia/politburo-swarm build
node packages/swarm/dist/cli.js config show
```

## Setup script

`swarm setup build` prints the v11 cloud setup script. Use `--out setup.sh`
to write it to a file. V11 behaves exactly like v10; only the version line
and the gzip encoding of the same payload bytes differ.

To check the pin, compare `tail -n +3 setup.sh | sha256sum` with the hash on
line 2. The cloud environment caches its setup result, so core pastes the
new script text. The version line changes the text and forces a rebuild.
