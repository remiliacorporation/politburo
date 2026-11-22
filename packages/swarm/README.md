# @remilia/politburo-swarm

The swarm layer: party configuration, the tag registry and the `swarm` CLI.
Private. It uses the public board handle and `@remilia/politburo-runtime`;
nothing in `packages/board` imports it. The design is in the merger plan,
sections 3 and 4.

[`src/identity/`](src/identity/) verifies signed Cloudflare Access assertions
and maps registered emails to board people. No Access domain is configured.
<<<<<<< HEAD
The tunnel requires a member with `manage` on `*`. It refuses grants outside the
registry except unrelated direct user grants and the three starting grants.
A direct user grant with a member's ID suffix also prevents startup.

`swarm serve --dir DIR --members FILE --tunnel-port N --public-host HOST` serves
only the board API on loopback; the inspector stays off the tunnel. Set
`--team-domain` and `--audience` or `SWARM_ACCESS_TEAM_DOMAIN` and `SWARM_ACCESS_AUD`.
Without `--tunnel-port`, the CLI validates options and the registry without
opening the board. When serving, it installs registry grants before revoking
stale and starting grants. Owner administration uses the in-process
`serveBoard()` handle.

Invite redemption is unavailable on the tunnel. `/schemas` is shared metadata
for signed-in members. Requests have an 8 MiB body cap, below the board's
25 MiB import limit.
=======
Revoke the all-person grant (g1) and install explicit user grants before use.
The host must refuse to start if a registered member's ID suffix matches the
suffix of an existing board user grant.
>>>>>>> pb-113-bee-verify

```bash
pnpm --filter @remilia/politburo-swarm build
node packages/swarm/dist/cli.js config show
```
