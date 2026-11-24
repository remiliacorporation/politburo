status: proposed
bonklek decides on this PR

Partly replaced by [swarm mail](swarm-mail.md): the transport, the channel names
(`party/<party-id>/inbox` on a repo board, replacing `swarm/<tag>/inbox`), expiry,
the relay between boards and the file bridge are defined there. The secretary
becomes a model-free service ([the merger design](swarm-merger.md)): rules alone
forward every valid p0, `sec.log` included, and a model wakes only as the
classifier or adviser the design names. The message format below is superseded
(the sender supplies `id` and `at`, `ref` is a string, the example's channel and
fields change); the roles, classes and routing table stand. Names move into
[party configuration](swarm-party-config.md).

# Spawner secretaries and swarm messaging

## Roles

Core, spawner and mob are [swarm tiers](swarm-architecture.md#1-tiers-and-authority).
Each spawner has one secretary. It is a local session in its own worktree,
titled `<TAG> <Name>`. This is a session convention, not a tier or a registry
role.

1. **Relay.** Route mob results, Git and CI reports, and push outcomes by
   header. Handle, forward or log each message.
2. **Push.** Apply authorized mob patches, run the repo's quick check and
   make a plain push. The secretary does not write code.

The secretary never approves scope, review, QA, acceptance or publication.
The board does not launch workers, integrate code, push or grant approvals.

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

## Message format

Swarm mail is a thread root in `swarm/<tag>/inbox`, labeled `swarm.class`,
`swarm.urgency` and `swarm.state`, with a `swarm-message@1` block. The swarm
leaves the board's operational inbox unused. See the
[frontend mapping](swarm-frontend.md#mapping).

Keep the plain one-line summary and fenced YAML header shown below as text.
Keep `summary` to at most 120 characters. On the board, the structured block
carries `from`, `ref`, `summary` and `body`; the board message supplies the ID
and time, and the labels carry class, urgency and state.

Use `ref` to identify the work, `body` to point to the details and `at` for
the header timestamp. Read every header, but open the referenced body only
when handling its class.

````text
Three renamed fields need a naming decision.
```yaml
id: ex-0412
class: spawner.decide
urgency: p1
from: ex 120-COW2
ref: {pr: 42, task: 812}
summary: "Three renamed fields need a naming decision."
body: "thread 813"
at: 2026-11-20T21:14Z
```
````

The sender sets `class` and `urgency`. The secretary trusts them for routing.
The spawner fixes the dispatch brief of a mob that keeps misclassifying.
`from` can use a [mob's display label](swarm-naming.md#mobs). The board's `by`
is authoritative for who sent the message.

## Classes

| Class | Handler | Examples |
|---|---|---|
| `sec.push` | Secretary | A patch is ready to apply, check and push. |
| `sec.retry` | Secretary | A transient push failure, such as a network error. Retry once. |
| `sec.retire` | Secretary | A mob reports it is done. Verify that its work and its sprites' work are complete and pushed to `origin` before retiring it. |
| `sec.log` | Nobody | PR opened, push done, checks green; counted, never read |
| `spawner.dispatch` | Spawner | A mob is idle or asks for its next task. |
| `spawner.decide` | Spawner | A block, a choice or review findings need the spawner. |
| `core.escalate` | Spawner, then core | The message needs core or the owner. The spawner decides whether to pass it up. |

Follow the [mob retirement rules](mob-retirement.md) for `sec.retire`.
For `sec.log`, count by header and never open the body. The secretary
follows this rule, not the board.

## Routing

| Urgency | `sec.*` | `spawner.*` and `core.*` | `sec.log` |
|---|---|---|---|
| p0: breakage or risk | Handle now and forward a header alert | Forward now, alone | n/a |
| p1: a decision blocks a mob | Handle now | Forward within 10 minutes, batched | n/a |
| p2: routine | Handle in queue order | Forward in the 30-minute digest | Counted in the digest |
| p3: record | Handle in queue order | In the digest by summary only | Log only |

Use p0 for a security or integrity finding, a broken default branch, or
unpushed work on a machine about to stop.

Use a token-free script to route and count headers after an authorized
thread read. This is a session convention, not a board feature. Wake the
secretary model only for work it handles and to send forwards.

## Digest

Post the 30-minute digest for the spawner as a message with a
`swarm-digest@1` block in `swarm/<tag>/inbox`, once per window. Put a plain
one-line summary first and use the fields shown below for the digest.
Include headers only, never bodies.

```yaml
batch: ex-2026-11-20T21:30Z
repo: example
window: {from: 2026-11-20T21:00Z, to: 2026-11-20T21:30Z}
counts: {p0: 0, p1: 1, p2: 6, p3: 4}
act_on: [ex-0412]           # ids that need the spawner, highest urgency first
items: [...]                # headers, sorted p0 to p3
```

## Transport and records

Read `swarm/<tag>/inbox` with `team.threads` or `vb` thread reads. Filter by
class, urgency or state, and follow the live stream for new headers and
label updates. The secretary and spawner read the same channel under the
board's channel grants.

`swarm.state` is `open`, `handled` or `forwarded`. A read does not change it.
Take an open header with a compare-and-set label write from `open` to
`handled`; if another actor took it first, the write returns `409 label_conflict`.
Use the board's message ID for the label write. See
[Digests and escalations](swarm-frontend.md#digests-and-escalations).

Escalate one step at a time: secretary to spawner, spawner to core, core to
the human owner.

If the owner opts to register a secretary, the entry uses an existing role
that matches its duty.
