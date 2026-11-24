# @remilia/politburo-swarm

The swarm layer: party configuration, the tag registry and the `swarm` CLI.
Private. It uses the public board handle and `@remilia/politburo-runtime`;
nothing in `packages/board` imports it. The design is in the merger plan,
sections 3 and 4.

[`src/identity/`](src/identity/) verifies signed Cloudflare Access assertions
and maps registered emails to board people. No Access domain is configured.
Revoke the all-person grant (g1) and install explicit user grants before use.
The host must refuse to start if a registered member's ID suffix matches the
suffix of an existing board user grant.

```bash
pnpm --filter @remilia/politburo-swarm build
node packages/swarm/dist/cli.js config show
```

## sync agent skills

Run `swarm skills sync --dir ./agent-skills --party party.yaml` to install skills.
Use `--repo` for repo overrides, `--dry-run` to preview, `--force` to replace unmarked files, or `--json` for file actions.

## Config keys read by code

Skills templates (`swarm skills sync`) read `claims.hours`, `claims.reclaim_cooldown_minutes`, `names.mob_species.*` (every passive, neutral, hostile, and boss pool the templates name), `names.sprite_items.*`, `review.code.review_rounds`, `review.code.fix_rounds`, `review.docs_only.model_review`, `setup.environment`, and `tiers.models.sprite.thinking`.

`swarm trackers scan` reads `trackers.<repo>.sources` and `trackers.<repo>.precedence`.

`swarm config show` and `swarm config validate` only print or validate the tree. A key not on this list is not in the schema. It comes back only with a reader.
