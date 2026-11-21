# Spawner secretaries and swarm messaging

Under this user-approved convention, each spawner has one secretary session.
The secretary routes messages by a small header to save spawner context and
opens a message body only when it handles that message's class.

## Roles

Core, spawner and mob refer to tiers in the [agent hierarchy](taxonomy.md).
The secretary is a convention carried by sessions and scripts, not a new
tier or functional role. Each secretary is a local session in its own
worktree, titled `<TAG> <Name>` (see [Secretary names](#secretary-names)).
It replaces a local push session.

The board does not launch workers, integrate code, push or grant approvals.
A secretary never approves scope, review, QA, acceptance or publication.

1. **Relay.** It takes in everything addressed to the spawner (mob results,
   Git and CI events, push outcomes). It routes each message by header:
   handle, forward or log.
2. **Push.** For authorized work, it applies a mob's patch, runs the repo's
   quick check and does a plain push. It never writes code.
   - Use a single swarm-wide check lock so only one secretary runs a quick
     check at a time. The lock lives in `$SWARM_NOTES_DIR`,
     a shared notes folder outside the repo. Run the check only after
     `mkdir "$SWARM_NOTES_DIR/check.lock"` succeeds. Remove the lock
     directory after the check.

## Secretary names

Under this user-approved naming convention, each secretary is a local session
titled `<TAG> <Name>`, for example `EX Peggy`. Names come from women
characters in a TV drama and are at most seven characters long.

A new secretary takes the first unused name in the order below and keeps it.
Never reuse a name while a secretary with that name is alive. This is a naming
convention only; the board does not assign names.

Peggy, Joan, Dawn, Ida, Allison, Lois, Hildy, Olive, Clara, Margie, Kathy,
Jenny, Scarlet, Fran, Betty, Megan, Sally, Trudy, Rachel, Midge, Faye, Shirley,
Jane, Bobbie, Suzanne, Sylvia, Mona, Marie, Carla, Diana, Beth, Rebecca, Anna,
Joyce, Bethany, Helen, Pima, Anita, Nan, Toni, Gloria.

## Message header

Read the header on every message. It is about 6 lines.

```yaml
id: ex-0412                 # assigned by the secretary, per repo
class: spawner.decide       # see Classes
urgency: p1                 # p0 | p1 | p2 | p3
from: ex 120-COW2           # mob, CI, push queue or git watcher
ref: {pr: 42, bead: <task-ref>}
summary: "three renamed fields need a naming decision"   # at most 120 characters
body: ex-inbox/ex-0412.yaml # detail, logs, diffs; opened only by the handler
at: 2026-11-20T21:14Z
```

The sender sets `class` and `urgency`, and the secretary trusts them for
routing. A spawner fixes the brief of any mob that repeatedly misclassifies
messages. Message metadata such as `from` may use a mob's display name; see
[swarm naming](swarm-naming.md#mobs).

## Classes

| Class | Handler | Examples |
|---|---|---|
| `sec.push` | Secretary | A patch is ready to apply, check and push |
| `sec.retry` | Secretary | A push failed for a passing reason (lock, network); one retry |
| `sec.retire` | Secretary | A mob says it is done; check that all its work and its sprites' work is on origin, then retire it |
| `sec.log` | Nobody | PR opened, push done, checks green; counted, never read |
| `spawner.dispatch` | Spawner | A mob is idle or wants its next task |
| `spawner.decide` | Spawner | A block, a choice, or review findings |
| `core.escalate` | Spawner, then core | Needs core or the user; the spawner decides whether to pass it up |

`sec.retire` follows the [mob retirement rules](mob-retirement.md).

## Routing

| Urgency | `sec.*` | `spawner.*` and `core.*` | `sec.log` |
|---|---|---|---|
| p0: breakage or risk | Handle now and forward a header alert | Forward now, alone | n/a |
| p1: a decision blocks a mob | Handle now | Forward within 10 minutes, batched | n/a |
| p2: routine | Handle in queue order | Forward in the 30-minute digest | Counted in the digest |
| p3: record | Handle in queue order | In the digest by summary only | Log only |

Use p0 for a security or integrity finding, a broken default branch, or
unpushed work on a machine about to stop.

## Digest: secretary to spawner

Headers only, never bodies.

```yaml
batch: ex-2026-11-20T21:30Z
repo: example
window: {from: 2026-11-20T21:00Z, to: 2026-11-20T21:30Z}
counts: {p0: 0, p1: 1, p2: 6, p3: 4}
act_on: [ex-0412]           # ids that need the spawner, highest urgency first
items: [...]                # headers, sorted p0 to p3
```

## Transport and records

- On the wire, put a plain one-line summary first, then the YAML in a fenced
  block. The recipient sees only the first line in preview.
- Append every header to `<tag>-secretary-log.yaml` in `$SWARM_NOTES_DIR`.
  Bodies live under `<tag>-inbox/` in that folder.
- Escalation goes one step at a time: secretary to spawner, spawner to core,
  core to the user.
- Cloud mobs cannot message local sessions. The secretary picks up mob
  results from mob reports and pushes, plus a token-free watch on Git and CI.
- Routing and counting should run in a token-free script, so the secretary
  model wakes only for `sec.*` work and to send forwards.
