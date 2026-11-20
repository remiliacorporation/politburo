# pb-2: why did PR #1 have no CI checks (report only)

Repo: remiliacorporation/politburo (only). Read-only task: write no code, push nothing, open no PR.

PR #1 (`feat(inspector): add the Politburo workbench`, branch `codex/politburo-remilia-frontend`) shows no status checks. Using `gh` (pr checks, run list, api for workflow runs) and `.github/workflows/check.yml`, find out:
1. Did the `check` workflow run for the PR head? If not, why (trigger rules, fork/approval gate, Actions disabled on this repo, branch filter)?
2. If it ran, did it pass? Give the failing step and the first error lines.
3. Is `check` a required status on `main`? (`gh api repos/remiliacorporation/politburo/branches/main/protection`, report 404 as "none").
Report in under 15 lines.
