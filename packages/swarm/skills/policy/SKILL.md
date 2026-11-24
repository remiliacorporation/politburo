---
name: policy
description: Apply party rules for review, claims, naming, and retirement.
---

## Review and merge

- Docs-only PRs: check links and format. Model review: {{yesno review.docs_only.model_review}}.
- Code PRs: run {{review.code.review_rounds}} review round(s), at most {{review.code.fix_rounds}} fix round(s), then a fixes-only re-review.
- BLOCKING means a security, privacy, auth, data-loss, or integrity finding,
  a failing check, or a violation of an invariant named in the brief. List
  every other finding as a follow-up in the PR body; do not fix it in the loop.
- Only an authorized spawner may merge, with green CI on the exact PR head
  and the latest review covering that same head with no findings above minor.
  A mob-checked sprite review must cover that head and does not replace any
  required independent review. Honor all repository gates, including human
  gates. If any gate is unmet, leave the PR open and list outstanding findings.
  Never merge to end a review loop. Mobs never merge, close, or delete remotely.

## Claims

Hard cutoff: {{claims.hours}} hours. Reclaim cooldown: {{claims.reclaim_cooldown_minutes}} minutes.

## Naming and class ceilings

| Where | Format |
| --- | --- |
| Spawner sidebar title | `<TAG> <NAME>` |
| Secretary title | `<TAG> <Name>` |
| Mob session title | `<tag> <serial>-<SPECIES><n>` |
| Sprite name | `<mob-id>.<ITEM><n>` |

The tag identifies the repo. The mob ID omits the tag. Add a species suffix
only when every species for the job has a live mob. Pick the first free item
for a sprite job; add an item suffix only for repeats within the same mob.
Keep spawner and secretary names for life. Never reuse a live session name.
Names are labels, not board identities or authority.

| Class | Ceiling | Limit |
| --- | --- | --- |
| Passive | Read, run checks, report | Never push |
| Neutral | Push work branches, open PRs | Never merge, close, or delete |
| Hostile | Merge, close PRs, delete branches | Clean gate required; not actions a mob may take |
| Boss | Swarm-wide operations | Explicit user approval for each operation |

Use the narrower of the class ceiling and actual authority. If the job needs
a higher class, rename and reassign the mob.

### Mob species by class and job

- Passive audit / inventory: {{join names.mob_species.passive.audit}}
- Passive research: {{join names.mob_species.passive.research}}
- Passive review: {{join names.mob_species.passive.review}}
- Passive status / relay: {{join names.mob_species.passive.status}}
- Passive gather patches: {{join names.mob_species.passive.gather}}
- Passive plan / brief: {{join names.mob_species.passive.plan}}
- Neutral build: {{join names.mob_species.neutral.build}}
- Neutral fix: {{join names.mob_species.neutral.fix}}
- Neutral refactor: {{join names.mob_species.neutral.refactor}}
- Neutral sync: {{join names.mob_species.neutral.sync}}
- Neutral port: {{join names.mob_species.neutral.port}}
- Neutral docs: {{join names.mob_species.neutral.docs}}
- Neutral CI / tooling: {{join names.mob_species.neutral.ci}}
- Hostile integration: {{join names.mob_species.hostile.integrate}}
- Hostile final gate and merge: {{join names.mob_species.hostile.merge}}
- Hostile revert / rollback: {{join names.mob_species.hostile.revert}}
- Hostile release: {{join names.mob_species.hostile.release}}
- Hostile raid: {{join names.mob_species.hostile.raid}}
- Hostile cleanup: {{join names.mob_species.hostile.cleanup}}
- Boss swarm-wide operations: {{join names.mob_species.boss}}

### Sprite items by job

- Implement: {{join names.sprite_items.implement}}
- Fix: {{join names.sprite_items.fix}}
- Review: {{join names.sprite_items.review}}
- Verify: {{join names.sprite_items.verify}}
- Research: {{join names.sprite_items.research}}
- Docs: {{join names.sprite_items.docs}}

## Retirement

1. Fetch `origin` on the mob's VM. Check that each owned branch and every
   worktree's `HEAD`, even detached, are contained in current `origin` branches.
2. Check that each worktree is clean, all work is complete, and no sprite is
   running or has unpushed work. If any check fails, stop; push only if
   authorized and recheck, or ask the spawner.
3. Settle or release every live claim. A handoff does not settle a claim.
4. Retire any registry entry with its current generation and authorized
   identity. Archive the harness session outside the board. Retirement does
   not accept or approve the work.
