status: proposed
bonklek decides on this PR

# Swarm mail

Swarm mail is a thread in the recipient's inbox channel.
A model-free service handles delivery, routing, expiry and receipts.
A relay crosses boards, and a temporary file bridge preserves per-tag rollback.

## What changes

The [operational inbox](../SPEC.md#operational-inbox) is not the transport (plan 6.1). The [Message and header row](swarm-frontend.md#mapping) (`design/swarm-frontend.md:125`) explains why: a send to the same recipient and topic replaces the old one, the read stops at 15, there is no feed or history, and the Vercel backend does not implement it. On main the send appends `operational.sent`, the reducer replaces the topic entry, and the read caps the result (`packages/board/src/server/operational-inbox.ts:33-45`, `packages/board/src/contract/reducers.ts:88-94`, `packages/board/src/server/backend-vercel.ts:704-705,3519`).

The old line 137 in [Swarm architecture, section 3](swarm-architecture.md#3-messaging) said the secretary relays through the operational inbox. It is wrong. The correction in this PR points to thread transport instead. The class handling and secretary naming conventions in [Swarm secretaries](swarm-secretaries.md) stay; this doc replaces transport, channel names, expiry and relay. Name pools move to [Party config](swarm-party-config.md) (plan 2, 4, 6.1).

## A message

One post creates a thread root with one `swarm-message@1` JSON block. The thread carries the labels `swarm.class`, `swarm.urgency` and `swarm.state`. Use `party/<party-id>/inbox` on the repo board for the spawner and `inbox` on the party board for core. The sender supplies every block field, including `id` and `at`. The labels follow the block: see the design choice under [Labels](#labels). The board supplies its own message ID, server timestamp and `by`. The block's `from` is a display or routing reference, not an authenticated author. Trust the board's `by`, never provenance asserted in the body (`AGENTS.md:336-337`, `packages/board/src/server/writes.ts:366-375`). On relay copies `by` identifies the relay; check the source thread's `by` for the original author.

Design choice: use a canonical string for `ref`, so a work reference has one dedupe representation. Keep the board ID separate from the sender's stable ID for retries and bridge round trips (plan 6.1).

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["id", "class", "urgency", "from", "ref", "summary", "body", "at"],
  "properties": {
    "id": {"type": "string", "minLength": 1, "maxLength": 200},
    "class": {"type": "string", "enum": ["sec.push", "sec.retry", "sec.retire", "sec.log", "spawner.dispatch", "spawner.decide", "core.escalate", "policy"]},
    "urgency": {"type": "string", "enum": ["p0", "p1", "p2", "p3"]},
    "from": {"type": "string", "minLength": 1},
    "ref": {"type": "string", "minLength": 1},
    "summary": {"type": "string", "maxLength": 120},
    "body": {"type": "string"},
    "at": {"type": "string", "format": "date-time"},
    "expires": {"type": "string", "format": "date-time"},
    "to": {"type": "string", "minLength": 1},
    "dispatch": {"type": "string", "minLength": 1}
  }
}
```

`to` is set only when the destination is another board: `<board>/<channel>`, read by the relay (see [Relay between boards](#relay-between-boards)). `dispatch` is optional and carries the dispatch envelope's execution id, so spend can join a message to its dispatch ([Spend](swarm-spend.md#the-dispatch-envelope)); the envelope itself stays in the ledger. A message's party is the party segment of its channel path and the party of its sender's principal; the block carries no party field, so the two cannot disagree. Names in the class enum describe the supported vocabulary. Read enabled classes from party config. The service checks timestamp syntax, label and block agreement, expiry eligibility and size before delivery. The board schema checks block shape, not recipient policy (plan 4, 6.1).

```json
{
  "id": "example-0412",
  "class": "spawner.decide",
  "urgency": "p1",
  "from": "attempt-120",
  "ref": "plb-482",
  "summary": "Three renamed fields need a naming decision.",
  "body": "See the review findings on the work item.",
  "at": "2026-11-20T21:14:00Z"
}
```

Register each version on each participating board with a handle allowed to call `createSchema`. The existing pattern is `registerScoreboardSchema` (`packages/runtime/src/router/scoreboard.ts:26-36`); registration validates the schema and records `schema.created` (`packages/board/src/server/schemas.ts:62-83`). The server resolves the schema for each `json#` block it finds and rejects unknown schemas and invalid blocks (`packages/board/src/server/serve.ts:512-529,627`). It does not require a mail block merely because a post lands in an inbox. The secretary validates the full mail contract.

## Labels

| Label | Values |
| --- | --- |
| `swarm.class` | `sec.push`, `sec.retry`, `sec.retire`, `sec.log`, `spawner.dispatch`, `spawner.decide`, `core.escalate`, `policy` |
| `swarm.urgency` | `p0`, `p1`, `p2`, `p3` |
| `swarm.state` | `open`, `handled`, `forwarded`, `expired`, `rejected` |

Design choice: the secretary service writes the three labels from the block when the root arrives, because a sender with `label` in the inbox could relabel other mail (see [Open](#open)). A root with no labels yet is unprocessed. The rest of this section is about labelled roots.

Design choice: use `rejected` and a reason reply for a root that reaches the inbox but fails validation, so it stays out of the queue without losing the explanation. If admission refuses it before a root exists, return the reason to the sender instead. A read is not a take. Use the board's message ID with a label write `if: { "swarm.state": "open" }` and set `swarm.state` to `handled` to take it. If it changed, nothing lands and the board answers 409 `label_conflict` (`packages/board/src/server/writes.ts:855-892`). A taken item still needs its action receipt; restart reconciles the receipt before retrying the action (plan 3.5, 6.2).

## Idempotency and dedupe

Use the sender's `id` as the post idempotency key. Main accepts the request `id` and looks up the landed event by that key; its retry check binds author and location, not equality of text or labels (`packages/board/src/api/routes.ts:160-181`, `packages/board/src/server/writes.ts:252,289-312`). The secretary compares the payload before treating it as the same send. A matching retry returns the existing result. Separately dedupe on `[from, ref, class]` within the recipient inbox, using only mail with verified sender provenance. Reject older `at` for that tuple, ID collisions, oversized mail and invalid mail, with a reason and a notice to the sender. WP-104 records the exact parity boundaries from `merger-plan.md` M05 (plan 6.1, WP-104).

## Expiry

Only p2 and p3 may carry the optional `expires`. The reader enforces it, including on relay and digest reads. An expired p2 never enters a digest; change an expired open root to `expired` without deleting the record. Reject p0 or p1 with `expires` (`merger-plan.md` M07, plan 6.1). The thread post schema has no expiry and block checking validates data, not its lifetime (`packages/board/src/api/routes.ts:160-181`, `packages/board/src/server/serve.ts:512-529`).

## Routing and digest

| Urgency | Default delivery to the spawner (plan 4, 6.2, D17) |
| --- | --- |
| p0 | Forward now, alone. Never classify. |
| p1 | Forward within 10 minutes, batched. |
| p2 | Put in the digest. |
| p3 | Include by summary only, subject to the class rules. |

The model-free secretary service uses party config for windows and [Swarm secretaries](swarm-secretaries.md#classes) for the unchanged class handling. `policy` carries config notices (WP-503). Post one `swarm-digest@1` block per configured window, 30 minutes by default. Keep `batch`, `repo`, `window`, `counts`, `act_on` and `items` from the [digest convention](swarm-secretaries.md#digest). Include headers, never bodies; keep p3 to summaries and count log-only mail under its class rules. Record a wake receipt for each wake, delivered or not. Delivery to the inbox is not a wake receipt. Jev and Terra do not own any of these writes (plan 6.2, 6.3).

## Relay between boards

Addressing: a sender that targets another board posts the block, with `to` set, to the `outbox` channel of its own board (`party/<party-id>/outbox` on a repo board, `outbox` on a party board). The relay reads every outbox root, posts the message to the `to` channel on the destination board and records delivery. Design choice: an outbox keeps the outbound record on the sender's board, with the source root and the sender's `id`, so a delivery has a durable source and a destination.

At-least-once transport, exactly once in effect. Write each mail root atomically with one post call. The relay retries with the sender's same `id` as the destination post key. It checks the landed root before recording delivery. A board outage stops only traffic for that board (plan 3.2, 6.1, WP-201).

Design choice: record delivery as an idempotent reply on the sender's thread and a delivery label on the receiver's thread, so either board can show what landed. Put the delivery label on the receiver root in the same post. The sender's reply names the destination and landed root. On recovery reconcile the destination before writing the sender receipt. A receiving secretary accepts the relay's copy only from the granted relay principal. It uses the relay's source reference and source board's `by`, not body text, for original provenance.

| Failure | Recovery |
| --- | --- |
| Sender dies | The single post leaves either no root or a complete root. Retry with the same ID. |
| Relay dies between delivery and sender record | Retry the post with the same ID, confirm the existing root and write the missing receipt once. |
| Receiver down | Leave delivery pending and retry that destination; other boards continue. |
| Duplicate delivery | Reuse the landed root and receipt. No second wake or digest entry for the delivery. |

## The two-way file bridge

Keep `<notes>/mail/<tag>/` current until the last tag moves, so any tag can fall back. Import files to board and export board mail to files, per the Tigeryard mail format. WP-104 supplies the exact format. Use `id` as the key both ways. Carry an origin marker so a bridged message never bridges back. At the `pb` to `plb` rename, resolve both tags to the same mailbox during cutover. Keep old IDs valid (D14, plan 6.1, 12 item 7, WP-202).

Rollback per tag in under five minutes: stop that tag's secretary service and start the old `secretary_wake` loop on the files the bridge kept current. Rehearse before the cutover gate. WP-803 removes the bridge (plan 7, 8).

## Channel and grants

Use [channel grants](../SPEC.md#grants) on the recipient inbox, not a swarm grant bypass. The secretary service reads and posts, including the routing and receipt writes; the spawner reads its own inbox and can reply there. Core is the corresponding recipient on the party board. Grant a sender principal `post` in the inbox and nothing else: no `label`, and no read of the mailbox merely for sending. The secretary service and the relay are the principals that hold `label` there. The relay receives the source read and receipt-write grants and the destination `post` and `label` it needs. On main a labeled post needs both `post` and `label` (`packages/board/src/server/writes.ts:164-182`); the service trusts validated author and block data, not an arbitrary label edit.

## Open

- Found here: WP-104 needs the exact file format, oversize boundary and older-`at` parity outcomes for `merger-plan.md` M05. Plan 6.1 does not specify those details.
- Found here: channel-wide `label` permission for a direct sender also authorizes label changes on existing messages in that channel (`packages/board/src/server/writes.ts:113-121,855-862`). Design choice, to be settled by WP-201: the sender posts the block without labels, and the secretary service, the only `label` holder in an inbox channel, writes the three labels from the block on arrival. That keeps `swarm.state` an exclusive take without a board change; see [board additions](swarm-board-additions.md#open).
- Found here: WP-201 must fix the scope for sender IDs when independent mailboxes converge on a board, and prove that simultaneous dedupe and a wake interrupted before its receipt cannot produce a duplicate effect. The board post key alone does not cover those cases.
