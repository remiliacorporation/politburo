status: proposed
bonklek decides on this PR

The naming convention stands. The name pools (spawners, secretaries, mob
species, sprite items) move into [party configuration](swarm-party-config.md)
as data, per [the merger design](swarm-merger.md). WP-102 moves the existing spawner constant (`packages/runtime/src/names.ts:5`) into config data.

# Mob and sprite naming

Use this convention for display names in the [swarm tiers](swarm-architecture.md#1-tiers-and-authority).

## Names and the board

A name is a display label. Use it in titles, briefs, reports and the `from`
field of a [swarm message](swarm-secretaries.md). The board uses the
[verified principal and optional profile](../SPEC.md#principals-profiles-actors)
for identity, not the display label. `--as` selects the profile.

An [agent registry](../packages/board/docs/01-board/13-agent-registry.md)
entry has a role, an optional parent, a harness and an identity binding. It
has no name or class field. Mob and sprite names do not map to registry roles.
A [claim binding](../packages/board/docs/01-board/11-tasks.md#bind-a-claim-and-hand-off-work)
records `controller`, `owner`, `provider`, `model`, `session`, `branch`,
`worktree` and `baseCommit`.

A mob can use only the [board permissions](../packages/board/docs/01-board/09-access.md#permissions)
its credentials allow: `read`, `post`, `label` and `manage`. A class changes
none of these grants and does not grant approval. The board does not enforce
class ceilings.

## Titles

| Where | Format |
| --- | --- |
| Spawner sidebar title | `<TAG> <NAME>` |
| Secretary title | `<TAG> <Name>` |
| Mob session title | `<tag> <serial>-<SPECIES><n>`; add `<n>` only when every species in the job's list has a live mob (e.g. mob ID `120-COW2`). |
| Sprite name | `<mob-id>.<ITEM><n>`; add `<n>` only when the same mob runs more than one sprite with that item (e.g. item `PICKAXE2`). |

The tag identifies the repo. A sprite name uses the mob ID, including any
species number, without the tag. Spawners and secretaries keep their names
for life. Do not reuse a name while a session with that name is alive.

### Spawner names

The design team keeps a separate pool for spawners. It uses industry nouns
transliterated from Russian, at most eight letters each. The five groups are
workplaces, bosses and roles, planning, tools and machines, and famous plants.

How a new spawner selects a name: To be confirmed.

### Secretary names

Use the [secretary name list](swarm-secretaries.md#secretary-names).

## Mobs

A mob ID takes the form `<serial>-<SPECIES><n>`. The session title starts with
the repo tag, as in `ex 120-COW2`.

- The spawner allocates serials from one counter for the whole swarm. The
  board has no serial counter. A failed allocation issues no serial. Never
  reuse a serial, even after [mob retirement](mob-retirement.md).
- Choose the job first. Take the first species in its list with no live mob.
  Species names have at most 8 characters.
- Add `<n>` only if every species in the job's list has a live mob. Use the
  first species in the list with its next free number.

### Class: what the mob may do on the remote

A class sets a ceiling on Git and PR actions. It grants no permission and
does not override repo rules, assignments or runner restrictions.

| Class | May | Never |
|---|---|---|
| Passive | Read, run checks, report | Push anything |
| Neutral | Push branches, open PRs | Merge, close or delete |
| Hostile | Merge, close PRs, delete branches | Act without a clean gate |
| Boss | Swarm-wide operations | Start without the user's explicit OK |

Mobs do not merge PRs. An authorized spawner follows the
[merge guardrail](swarm-architecture.md#merge-guardrail). If a job needs more
than the mob's class allows, rename the mob.

### Passive

| Job | Species |
|---|---|
| Audit / inventory | COW, SHEEP, MOOSH, CHICKEN, PIG |
| Research | FOX, CAT, OCELOT |
| Review (review sprites, defect list) | BAT, AXOLOTL, FROG, TURTLE, TADPOLE, PUFFER |
| Status / relay | PARROT, RABBIT, SQUID, COD, SALMON |
| Gather patches for a push session | ALLAY, DONKEY, MULE, CAMEL, HORSE, SKORSE, ZORSE |
| Plan / brief (in its report) | VILLAGER, SNOWMAN |

### Neutral

| Job | Species |
|---|---|
| Build a feature | BEE, DOLPHIN |
| Fix bugs or review findings | WOLF, POLAR |
| Refactor / split code | ENDERMAN, SPIDER |
| Sync (merge in the default branch locally, update stacked PRs) | GOAT, PIGLIN |
| Port across repos | LLAMA |
| Docs | PANDA, CAVSPIDR |
| CI, checks and tooling | GOLEM, PIGMAN |

### Hostile

| Job | Species |
|---|---|
| Integration (many PRs into one merge) | CREEPER, HOGLIN, ZOGLIN, BRUTE |
| Final gate and merge of one PR | GUARDIAN, SHULKER, WITCH |
| Revert / rollback | SKELETON, STRAY, WITHSKEL |
| Release (tag, version bump, changelog) | BLAZE, GHAST, PHANTOM |
| Raid (bulk close or relabel many PRs) | PILLAGER, VINDICTR, EVOKER, VEX |
| Cleanup (stale PRs, merged branches) | ZOMBIE, HUSK, DROWNED, ZILLAGER, SILVER, MITE, SLIME, MAGMA |

### Boss

DRAGON, WITHER, WARDEN, ELDERG. Use these only for swarm-wide operations.
Each operation needs the user's explicit OK.

## Sprites

A sprite name takes the form `<mob-id>.<ITEM><n>`, as in `21-BEE.PICKAXE`
or `120-COW2.BOOK`. The mob picks the first free item for the sprite's job.
Add `<n>` only when the same mob runs more than one sprite with that item,
as in `21-BEE.PICKAXE2`.

Pass the name to the sprite's launcher in the form it accepts. The runtime's
[`pi()` adapter](../packages/runtime/README.md) passes the task file to
`pi-task`. See [sprite runs](swarm-architecture.md#sprite-runs).

| Sprite job | Items |
|---|---|
| Implement code | PICKAXE, AXE, SHOVEL, HOE |
| Fix defects | ANVIL, SHEARS, FLINT |
| Review (adversarial) | SWORD, BOW, TRIDENT |
| Verify / run checks | COMPASS, CLOCK |
| Research / read | MAP, BOOK |
| Docs / write | QUILL, SIGN |
