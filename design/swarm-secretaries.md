status: proposed
bonklek decides on this PR

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

Swarm mail uses the board's [operational inbox](../SPEC.md#operational-inbox).

- Set `to` to `{ agent: ... }` with the spawner's verified principal ID, not
  a profile. To address a role from `inboxRoles`, use `{ role: ... }`.
- Use one `topic` per logical item. A newer send with the same recipient
  kind, recipient ID and topic permanently replaces the older message.
- Put the summary and routing header in `text`.
- The board assigns the message `id`, identifies the sender in `by` and
  records the send time in `sentAt`. The sender can set an `expiresAt` cutoff.
- The board keeps `seenAt`, `actedAt` and `archivedAt` per principal. They
  record the times of `seen`, `acted` and archive actions.

Put a plain one-line summary first in `text`, then a fenced YAML header. The
board treats the header as text. Keep `summary` to at most 120 characters.
The secretary assigns the header `id` per repo. It is separate from the
board's message `id`.

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
An inbox read returns the message `text`. For `sec.log`, count by header
and never open the body. The secretary follows this rule, not the board.

## Routing

| Urgency | `sec.*` | `spawner.*` and `core.*` | `sec.log` |
|---|---|---|---|
| p0: breakage or risk | Handle now and forward a header alert | Forward now, alone | n/a |
| p1: a decision blocks a mob | Handle now | Forward within 10 minutes, batched | n/a |
| p2: routine | Handle in queue order | Forward in the 30-minute digest | Counted in the digest |
| p3: record | Handle in queue order | In the digest by summary only | Log only |

Use p0 for a security or integrity finding, a broken default branch, or
unpushed work on a machine about to stop.

Use a token-free script to route and count headers after an authorized inbox
read. This is a session convention, not a board feature. Wake the secretary
model only for work it handles and to send forwards.

## Digest

Send the 30-minute digest as an inbox message to the spawner. Use one `topic`
per window. Put a plain one-line summary first, then the fenced digest YAML.
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

Send through the [SDK](../packages/board/docs/04-reference/02-board.md#operationalinbox)
(`team.operationalInbox`) or HTTP. The CLI does not send inbox mail. The inbox
works on `local()` and over HTTP to a board that keeps it. Vercel's board
answers 501 `no_operational_inbox`.

Send needs board-wide `post`. Read, `ack` and `archive` need board-wide `read`.
Inbox mail never appears in feeds, threads, watchers or sync. Each member of
an inbox role can see mail sent to that role. Direct mail to the spawner does
not appear in a separate secretary principal's inbox. For shared delivery,
address a configured inbox role that includes both principals.

1. Read with `vb inbox read`. A read does not acknowledge mail.
2. Record `seen` with `vb inbox ack <id> seen`. When the message is handled,
   record `acted` with `vb inbox ack <id> acted`. This also records `seen` if
   it was not already set.
3. Archive when done with `vb inbox archive <id>`. This hides the message for
   that principal only. Use the board's message `id` for `ack` and `archive`.

Read shows at most 15 active messages, newest first. Drain the inbox each
wake. Read again after archiving handled mail to reach older messages. There
is no paging or archive read. Set `expiresAt` on mail that goes stale. The
board checks expiry on read.

Escalate one step at a time: secretary to spawner, spawner to core, core to
the human owner.

The [runtime's `runController`](../packages/runtime/README.md#controller-loop)
wakes a handler on inbox mail. It records `seen` before calling the handler and
`acted` when the handler reports the work is done. If the message is still
visible and unacted at the deadline, the caller-supplied `parentOf` looks up the immediate registry
parent. If there is a parent, the loop sends one reference, not the message text.

If the owner opts to register a secretary, the entry uses an existing role
that matches its duty.
