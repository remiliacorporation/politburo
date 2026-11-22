# @remilia/politburo-swarm

The swarm layer: party configuration, the tag registry and the `swarm` CLI.
Private. It uses the public board handle and `@remilia/politburo-runtime`;
nothing in `packages/board` imports it. The design is in the merger plan,
sections 3 and 4.

[`src/identity/`](src/identity/) verifies signed Cloudflare Access assertions
and maps registered emails to board people. No Access domain is configured.
Revoke the all-person grant (g1) and install explicit user grants before use.
The host must refuse to start if a registered member's ID suffix matches the
suffix of an existing board user grant. `swarm serve` enforces this check.

`swarm serve --dir DIR --members FILE --tunnel-port N --public-host HOST` serves
only the board API on loopback; the inspector stays off the tunnel. Set
`--team-domain` and `--audience` or `SWARM_ACCESS_TEAM_DOMAIN` and `SWARM_ACCESS_AUD`.
Without `--tunnel-port`, it reconciles grants and exits without listening. The
member registry replaces the starting grants; keep its IDs distinct from existing
board user IDs. Owner administration uses the in-process `serveBoard()` handle.

```bash
pnpm --filter @remilia/politburo-swarm build
node packages/swarm/dist/cli.js config show
```
