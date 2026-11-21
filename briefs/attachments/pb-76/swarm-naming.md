# Mob and sprite naming

This is the user-approved convention for naming mobs and sprites. It applies
to every spawner, mob and sprite. Names are labels and appear only in session
titles, briefs, reports, sprite names and message metadata (such as `from`).
They leave each workflow's existing branch and status-ref formats unchanged,
including `<owner>/<topic>` where used.

Related: [agent hierarchy](taxonomy.md),
[spawner secretaries](swarm-secretaries.md) and
[mob retirement](mob-retirement.md).

## Mobs

A mob is a cloud task session at the mob tier of the core, spawner, mob and
sprite hierarchy. The eight functional roles are unchanged.

Format: `<serial>-<SPECIES><n>`. Prefix the cloud session title with the
repo tag, as in `ex 120-COW2`.

- **Serial:** Use one counter for the whole swarm and never reuse a serial.
  Take the next serial with the command below.
- **Species:** Pick the job, then the first species in its list with no live
  mob.
- **`<n>`:** Use a number only when every species in the list has a live mob.
  Then reuse the first species with the next free number, as in `120-COW2`.
- Species names are 8 characters or fewer.

Use `$SWARM_NOTES_DIR`, a shared notes folder outside the repo, for the
counter.

```bash
N="$SWARM_NOTES_DIR"; until mkdir "$N/mob-serial.lock" 2>/dev/null; do sleep 1; done; s=$(( $(cat "$N/mob-serial.txt" 2>/dev/null || echo 0) + 1 )); echo "$s" > "$N/mob-serial.txt"; rmdir "$N/mob-serial.lock"; echo "$s"
```

Before running the command, set `$SWARM_NOTES_DIR` to an existing, writable
notes folder. Do not treat a failed run as issuing a serial, even if it prints
one.

To retire a mob, follow the [mob retirement procedure](mob-retirement.md).

### Class: what the mob may do on the remote

This table is policy for what a mob may do, not board enforcement.
A class name does not grant approval.

Classes are ceilings on what a mob may do on the remote; they do not override
a project's existing roles, assignments or harness restrictions. A Passive mob
reports without pushing (for example, in its final message or via the spawner's
chosen reporting path), so a job that needs to push status is Neutral.

| Class | May | Never |
|---|---|---|
| Passive | Read, run checks, report | Push anything |
| Neutral | Push branches, open PRs | Merge, close or delete |
| Hostile | Merge, close PRs, delete branches | Act without a clean gate |
| Boss | Swarm-wide operations | Start without the user's explicit OK |

A mob whose job needs more than its class allows is the wrong species.
Rename it; don't stretch the class.

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

DRAGON, WITHER, WARDEN, ELDERG. Swarm-wide operations only, each with the
user's explicit OK.

## Sprites

Format: `<mob-id>.<ITEM><n>`, for example `21-BEE.PICKAXE` or
`120-COW2.BOOK`. The name is a label only. Pass it to whichever launcher
the environment provides, using the form that launcher expects, such as the
brief filename passed to [`pi-task`](taxonomy.md#sprite-first-cloud-briefs).
With `sprite-start`, for example: `sprite-start 21-BEE.PICKAXE task.md`.

- The mob picks the first free item for the sprite's job.
- Use `<n>` only when the same mob runs two sprites with the same item, as in
  `21-BEE.PICKAXE2`.

| Sprite job | Items |
|---|---|
| Implement code | PICKAXE, AXE, SHOVEL, HOE |
| Fix defects | ANVIL, SHEARS, FLINT |
| Review (adversarial) | SWORD, BOW, TRIDENT |
| Verify / run checks | COMPASS, CLOCK |
| Research / read | MAP, BOOK |
| Docs / write | QUILL, SIGN |
