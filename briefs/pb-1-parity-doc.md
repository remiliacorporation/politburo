# pb-1: commit the Tigeryard parity intent document

Repo: remiliacorporation/politburo (only). Never push to vercel/board or any upstream.

## Goal
Add `TIGERYARD-PARITY.md` at the repo root, with the exact content of the file in this brief's sibling `pb-1-TIGERYARD-PARITY.md`, via a docs-only PR to `main`.

## Steps (mob does minimal processing; use a pi sprite for the work)
1. Branch `docs/tigeryard-parity` from `main`.
2. Copy `briefs/pb-1-TIGERYARD-PARITY.md` to `TIGERYARD-PARITY.md` at the repo root. Change nothing else. Do not touch SPEC.md or packages/.
3. No changeset (docs only).
4. Commit as `bonklek <bonklek@users.noreply.github.com>`, message `docs: add the Tigeryard parity intent document`. No --no-verify, no force-push, no rebase.
5. Open a PR to remiliacorporation/politburo `main`. Title: `docs: add the Tigeryard parity intent document`. Body: one line saying what it is, then four answers (Users: none; Protocol / backends: none; Performance / I/O: none; Tests: none, docs only). Follow the repo's AGENTS.md "pr titles and descriptions".
6. Wait for the `check` job with `gh pr checks`. Report PR link and CI result. Do not merge.
Run nothing heavy locally. If a sprite fails twice, report blocked.
LIMITS (read before starting sprites): run up to 5 sprites in parallel with separate jobs, but only ONE `pnpm check` at a time on this VM, always through the slot: `flock -w 1800 /tmp/pnpm-check.lock env VITEST_MAX_WORKERS=2 NODE_OPTIONS=--max-old-space-size=2048 pnpm check` (flock is released if the process dies; two parallel full builds were OOM-killed with exit 137 before). Sprites run targeted `vitest run <file>` and the package typecheck, not the full check; the mob runs the full check once per head. Never start two builds at once. If a sprite or this session stops with a usage-limit or 'limit reached' error, that is infrastructure: wait for the spawner's resume message or press Try again; do not retry in a loop. If `sprite-watch` reports no event for 180 s, re-run it once before treating the sprite as failed.
