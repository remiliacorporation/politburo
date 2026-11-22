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
LIMITS (measured, not fixed): there is NO fixed sprite cap. Sprites are mostly idle waiting on a model, so admit them by headroom, and gate only the heavy jobs by measured memory. (1) Before the first sprite, measure this VM once: nproc, MemAvailable (/proc/meminfo), and the peak RSS and wall time of one `pnpm check` (use /usr/bin/time -v, or sample ps). (2) Light sprites (model calls, reading, editing): start another while MemAvailable stays above 25% of MemTotal and the 1-minute load average stays below nproc; stop adding the moment either fails, or the router reports a rate limit, cooldown or 'usage limit' (back off, do not loop). (3) Heavy jobs (pnpm check, builds, full vitest): allow N at once where N = floor(MemAvailable / (1.3 x measured peak RSS of one check)), at least 1, implemented as N flock slots (`flock -w 1800 /tmp/heavy-slot-<i>.lock env VITEST_MAX_WORKERS=<nproc/2, min 1> NODE_OPTIONS=--max-old-space-size=<peak MB> <command>`, trying each slot in turn); the earlier exit-137 kills were two parallel full builds on one VM. (4) Sprites prefer targeted `vitest run <file>` and the package typecheck; the mob runs the full check once per head. (5) Record the measurements and your chosen limits in your final message so the spawner can set the next cap from data. (6) A usage-limit or 'limit reached' error is infrastructure: wait for the spawner's resume message or press Try again once. If `sprite-watch` reports no event for 180 s, re-run it once before calling the sprite failed.
