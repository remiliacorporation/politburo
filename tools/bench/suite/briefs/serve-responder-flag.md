# Let named responders answer task attention

`vb serve --swarm` lets the local owner answer structured task attention.
Operators need to name other responders, including on a team-token board,
without having to enable swarm features.

Add repeatable `vb serve --responder <principal>`. Accept principal IDs from
`vb whoami --json`, not handles or profiles. On team-token boards the ID is
`team:user:<handle>`. Reject invalid values as a usage error before starting
and do not echo them. Deduplicate the list and apply it to all channels.
Listed people must still act as themselves and have read and post access.

The flag alone enables structured attention for the listed people, not agent
ops or swarm discovery. When combined with `--swarm`, keep the local owner
on the list. Keep the existing `--swarm` and `--team-tokens` incompatibility,
and leave behavior without the new flag alone.

Look in `packages/board/src/cli/` for command definitions, local serving and
swarm configuration, and `packages/board/src/server/auth.ts` for principal
validation. Update `vb serve --help`, the CLI reference and the local-board
docs. Use `pnpm check` to check your work.

Do not commit, do not read any git history beyond the working tree.
