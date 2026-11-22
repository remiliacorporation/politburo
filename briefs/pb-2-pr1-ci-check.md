# pb-2: why did PR #1 have no CI checks (report only)

Repo: remiliacorporation/politburo (only). Read-only task: write no code, push nothing, open no PR.

PR #1 (`feat(inspector): add the Politburo workbench`, branch `codex/politburo-remilia-frontend`) shows no status checks. Using `gh` (pr checks, run list, api for workflow runs) and `.github/workflows/check.yml`, find out:
1. Did the `check` workflow run for the PR head? If not, why (trigger rules, fork/approval gate, Actions disabled on this repo, branch filter)?
2. If it ran, did it pass? Give the failing step and the first error lines.
3. Is `check` a required status on `main`? (`gh api repos/remiliacorporation/politburo/branches/main/protection`, report 404 as "none").
Report in under 15 lines.
LIMITS (read before starting sprites): run up to 5 sprites in parallel with separate jobs, but only ONE `pnpm check` at a time on this VM, always through the slot: `flock -w 1800 /tmp/pnpm-check.lock env VITEST_MAX_WORKERS=2 NODE_OPTIONS=--max-old-space-size=2048 pnpm check` (flock is released if the process dies; two parallel full builds were OOM-killed with exit 137 before). Sprites run targeted `vitest run <file>` and the package typecheck, not the full check; the mob runs the full check once per head. Never start two builds at once. If a sprite or this session stops with a usage-limit or 'limit reached' error, that is infrastructure: wait for the spawner's resume message or press Try again; do not retry in a loop. If `sprite-watch` reports no event for 180 s, re-run it once before treating the sprite as failed.
