# @remilia/politburo-swarm

The swarm layer: party configuration, the tag registry and the `swarm` CLI.
Private. It uses the public board handle and `@remilia/politburo-runtime`;
nothing in `packages/board` imports it. The design is in the merger plan,
sections 3 and 4.

[`src/identity/`](src/identity/) verifies signed Cloudflare Access assertions and
maps registered emails to board people. No Cloudflare domain is configured yet;
this library is not wired into serving or the inspector. Before enabling it,
revoke the board's default all-person grant (g1) and install explicit user grants.
Keep the Cloudflare IDs' suffixes distinct from existing board user IDs.

```bash
pnpm --filter @remilia/politburo-swarm build
node packages/swarm/dist/cli.js config show
```
