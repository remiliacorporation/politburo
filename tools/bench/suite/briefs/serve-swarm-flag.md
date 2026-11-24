# Serve a swarm board locally

A local board already enforces task authority. Give its owner a single switch
to enable agent ops and answer structured task attention: `vb serve --swarm`.
Keep ordinary `vb serve` and standalone `--agent-ops` behavior unchanged.
Reject `--swarm` with `--team-tokens` as a usage error before startup.

A swarm board adds `politburo: 1` to `GET /` discovery alongside its agent ops,
intents, task attention and task authority capabilities. Do not advertise
`politburo` on stock boards. The responder list should name only the local
owner (`local:user:<handle>`), across all channels. Support `*` in the local
board's responder configuration without changing exact-channel matching or
granting channel access. Keep the verified-person, acting-as-self, read and
post requirements. Invited people and separate Tailscale identities do not
automatically become responders.

The serve command is in `packages/board/src/cli/`, local board and task
authorization code is in `packages/board/src/server/`, and the discovery
type is in `packages/board/src/api/routes.ts`. Update `vb serve --help`, the
CLI reference, and the local and task docs. Use `pnpm check` to check your work.

Do not commit, do not read any git history beyond the working tree.
