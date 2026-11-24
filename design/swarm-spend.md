status: proposed
bonklek decides on this PR

# Dispatch envelope and spend ledger

Every dispatch records who pays before any work starts.
One ledger accounts for the party (Party); the boards show its projections.
Admission reserves capacity before launch, and missing usage stays visible (D8, plan 3.4).

## Accounting authority

One append-only ledger on the Mac Studio is the accounting authority for a party (plan 3.3 and 3.4). A single writer owns one accounting SQLite file for all boards. The party board (Standing Committee) shows the party roll-up. The repo board (work board) refers to the ledger by board id and repo id and shows a projection in `party/<party-id>/spend`. Never sum asynchronously mirrored balances to admit work. See [architecture](swarm-merger.md).

When a board claim and a ledger reservation cannot share a transaction, persist a fenced pending-dispatch record. Bind the reservation and the board-confirmed claim to the same dispatch intent. Launch only when both are confirmed and their fences remain current. On a definitive failure, compensate by releasing the reservation and any claim still held by that intent. On an ambiguous result, reconcile the existing intent before releasing capacity or retrying the launch. See plan 3.5 rule 3 and `sota-usage-tracking.md` section 4.

## The dispatch envelope

Create and persist the envelope on every dispatch before work starts. Design rule 3 says to record identity before a side effect (plan 3.5). A sprite inherits its mob's work attempt and gets its own execution id. A retry does not overwrite an earlier dispatch. The envelope reference travels in the [structured mail block](swarm-mail.md) and the brief (plan 6.1 and WP-208). It identifies work; it does not grant authority.

| Field | Type | Who assigns it | Example |
| --- | --- | --- | --- |
| `party` | Stable id | Dispatcher from party membership | `default` |
| `repo` | Stable repo id or null for party overhead | Dispatcher from the route | `plb` |
| `work_id` | Canonical work id or null for overhead | Dispatcher from the work item | `plb-482` |
| `attempt` | Work-attempt id or null for overhead | Dispatcher binds a new attempt; children inherit it | `att-42` |
| `tier` | `core`, `spawner`, `secretary`, `mob`, `sprite` or `jockey` | Dispatcher from the execution role | `sprite` |
| `parent` | Parent execution id or null | Launching supervisor from the recorded parent | `exec-70` |
| `session` | Internal session reference | Dispatcher before launch; receiver binds native ids to it | `sess-91` |
| `trace` | Trace id plus execution id | Dispatcher allocates the execution id and propagates the trace | `{ "id": "tr-42", "execution_id": "exec-91" }` |

Design choice: `trace` carries the execution id and `session` is allocated locally, so the eight envelope fields stay fixed and the envelope need not change when a provider assigns its session id. Separate execution ancestry from the immutable sponsoring spawner recorded with the dispatch. An overhead dispatch has no work attempt, not a fabricated work id.

Bind a native session and process incarnation to the envelope explicitly. Early telemetry stays `pending` until that binding arrives. A shared session needs an explicit request-to-dispatch binding for work-level attribution. Never attribute by session name, cwd, branch or time proximity alone. Keep unmatched evidence visible without assigning it to work.

## Three meters

| Meter | Meaning | Missing data |
| --- | --- | --- |
| Reported tokens | Exact counts as reported, by bucket: input uncached, input total, output, cache read, cache write and reasoning. Preserve source semantics. Do not add inclusive input or reasoning to buckets that already contain it. | Buckets are nullable. Mark missing expected counts `unknown`; do not fill by subtraction or zero. |
| Priced usage | Label as an estimate. `estimate = (record window tokens / total window tokens) × (subscription price × window share of subscription price)`. Inputs are the billing scope, subscription window, comparable token basis and numerator, total tokens in that same window, subscription price and currency, and the window's fraction of that price. | `unknown` if an input is missing or the share is undefined. A quota percentage is not a token count. |
| Settled charges | Where a bill exists, keep the exact source amount and currency at the grain billed. Never recompute it or allocate it to work without evidence. | No bill or no attributable bill line means no known settled charge for that scope. |

Dollars are never added to tokens. Estimates are never added to settled charges (D8, plan 3.4). Track other resources in their own units: worker seconds, elapsed active time, CI job seconds, calls and explicitly timed or self-reported human attention (`sota-usage-tracking.md` section 5). Use monotonic durations within a process and UTC for joins and windows. Sum disjoint worker intervals for effort, and take the union of active intervals for elapsed time. A heartbeat is not a VM billing clock or a measure of human attention.

## Unknown is never zero

Each meter field carries provenance or `unknown` in `field_quality`. Null with `unknown` does not mean a reported `0`. Every fact also has record-level `coverage.state`; neither a healthy heartbeat nor a successful exit supplies missing data (plan 3.5 rule 4).

| Coverage state | Meaning |
| --- | --- |
| `live` | The source is current but the execution or observation window is still open. |
| `pending` | Evidence or identity binding is expected but has not arrived. |
| `partial` | Some expected fields, requests or intervals are missing. |
| `unattributed` | Evidence exists, but no reliable binding assigns it to an envelope. |
| `conflict` | Sources disagree or the binding is ambiguous; do not admit a disputed value as exact. |
| `closed_reconciled` | The observation is final and checked at the source's grain. Unavailable fields can still be unknown. |

A roll-up shows the known subtotal and unknown-record count for each meter or bucket, never a bare sum. An expected but missing record contributes a coverage gap and an unknown count. Example: one record reports 120 output tokens, one reports 0 and one is unknown. Display `120 known output tokens; 1 unknown record`, not `120 total`. Unknown spend counts against the party score (plan 6.7, WP-701).

## The spend record

A record is one exclusive fact: a model response, resource interval or discrete charge. Snapshots and aggregates are observations, not extra spend. If an aggregate is the only countable evidence for a disjoint interval, do not also count its constituents. Reservations are admission facts, not charges (plan 3.4; `sota-usage-tracking.md` section 4).

| Group | Fields and rule |
| --- | --- |
| Identity | `record_id`, `dedupe_key`, `revises`; a correction adds `actor` and `reason`. |
| Dispatch | `envelope`, the immutable envelope; null only while an unbound observation is quarantined. |
| Source | `source`, `source_version`, `source_event_key`, `evidence_ref`; reference sanitized evidence, not a raw transcript. |
| Model | `provider`, `requested_route`, `actual_model`, `auth_class`; use unknown if not observed and not applicable for non-model facts. |
| Tokens | `tokens` has the six nullable buckets. |
| Amount | `amount` is an exact decimal string plus its currency or unit, or null. `basis` distinguishes `priced_estimate`, `settled_charge`, `measured_resource` and `unknown` or `not_applicable`. Pricing evidence identifies its inputs and revision. |
| Time | `occurred`, `received`, `started`, `ended`; UTC, nullable if unavailable except for receipt time. |
| Status | `status`, the outcome of this observation or execution, separate from coverage. Keep the source exit reason where available. |
| Coverage | `coverage` holds `state` and `field_quality`. Missing fields remain visible. |

Design choice: make correction metadata part of the superseding record and store decimal amounts as strings, so an audit keeps the original fact and avoids floating-point rounding. The writer enforces unique record ids and dedupe keys and a single active head per correction chain. A correction appends a new record with `revises`, actor and reason. Nothing rewrites history; totals read the current head once. Binding a quarantined observation appends its attributed successor, not a second charge.

Example records use illustrative source versions and values. The sprite has a priced estimate; the local Claude request has no pricing inputs. Neither example asserts a bill.

```json
[
  {
    "record_id": "sp-1001", "dedupe_key": "pi:exec-91:1:4", "revises": null,
    "envelope": {"party": "default", "repo": "plb", "work_id": "plb-482", "attempt": "att-42", "tier": "sprite", "parent": "exec-70", "session": "sess-91", "trace": {"id": "tr-42", "execution_id": "exec-91"}},
    "source": "pi_json", "source_version": "fixture-1", "source_event_key": "exec-91:1:4", "evidence_ref": "usage/pi/1001",
    "provider": "openai", "requested_route": "fallback/codex-cursor", "actual_model": "codex-example", "auth_class": "subscription",
    "tokens": {"input_uncached": 800, "input_total": 1000, "output": 120, "cache_read": 200, "cache_write": null, "reasoning": null},
    "amount": {"value": "0.0042", "unit": "USD"}, "basis": "priced_estimate",
    "occurred": "2026-11-22T12:02:00Z", "received": "2026-11-22T12:02:01Z", "started": "2026-11-22T12:01:55Z", "ended": "2026-11-22T12:02:00Z",
    "status": "completed", "exit_reason": "normal",
    "coverage": {"state": "partial", "field_quality": {"tokens.input_uncached": "provider_reported", "tokens.input_total": "provider_reported", "tokens.output": "provider_reported", "tokens.cache_read": "provider_reported", "tokens.cache_write": "unknown", "tokens.reasoning": "unknown", "amount": "priced_estimate"}}
  },
  {
    "record_id": "sp-1002", "dedupe_key": "claude:exec-50:req-11:resp-1", "revises": null,
    "envelope": {"party": "default", "repo": "plb", "work_id": "plb-482", "attempt": "att-42", "tier": "spawner", "parent": null, "session": "sess-50", "trace": {"id": "tr-42", "execution_id": "exec-50"}},
    "source": "claude_local_request", "source_version": "fixture-1", "source_event_key": "req-11:resp-1", "evidence_ref": "usage/claude/1002",
    "provider": "anthropic", "requested_route": "claude-local", "actual_model": "claude-example", "auth_class": "subscription",
    "tokens": {"input_uncached": 240, "input_total": null, "output": 91, "cache_read": 0, "cache_write": 0, "reasoning": null},
    "amount": null, "basis": "unknown",
    "occurred": "2026-11-22T12:00:06Z", "received": "2026-11-22T12:00:07Z", "started": "2026-11-22T12:00:03Z", "ended": "2026-11-22T12:00:06Z",
    "status": "completed",
    "coverage": {"state": "closed_reconciled", "field_quality": {"tokens.input_uncached": "provider_reported", "tokens.input_total": "unknown", "tokens.output": "provider_reported", "tokens.cache_read": "provider_reported", "tokens.cache_write": "provider_reported", "tokens.reasoning": "unknown", "amount": "unknown"}}
  }
]
```

JSON Schema sketch. The ingest validator also checks field provenance, amounts against their basis, and identity joins against the ledger.

```json
{
  "type": "object",
  "required": ["record_id", "dedupe_key", "revises", "envelope", "source", "source_version", "source_event_key", "evidence_ref", "provider", "requested_route", "actual_model", "auth_class", "tokens", "amount", "basis", "occurred", "received", "started", "ended", "status", "coverage"],
  "properties": {
    "record_id": {"type": "string"}, "dedupe_key": {"type": "string"},
    "revises": {"$ref": "#/$defs/nullable_text"}, "actor": {"type": "string"}, "reason": {"type": "string", "minLength": 1},
    "envelope": {
      "type": ["object", "null"], "additionalProperties": false,
      "required": ["party", "repo", "work_id", "attempt", "tier", "parent", "session", "trace"],
      "properties": {
        "party": {"type": "string"}, "repo": {"$ref": "#/$defs/nullable_text"}, "work_id": {"$ref": "#/$defs/nullable_text"},
        "attempt": {"$ref": "#/$defs/nullable_text"}, "tier": {"enum": ["core", "spawner", "secretary", "mob", "sprite", "jockey"]},
        "parent": {"$ref": "#/$defs/nullable_text"}, "session": {"type": "string"},
        "trace": {"type": "object", "required": ["id", "execution_id"], "properties": {"id": {"type": "string"}, "execution_id": {"type": "string"}}}
      }
    },
    "source": {"type": "string"}, "source_version": {"type": "string"}, "source_event_key": {"type": "string"}, "evidence_ref": {"type": "string"},
    "provider": {"$ref": "#/$defs/nullable_text"}, "requested_route": {"$ref": "#/$defs/nullable_text"}, "actual_model": {"$ref": "#/$defs/nullable_text"}, "auth_class": {"$ref": "#/$defs/nullable_text"},
    "tokens": {
      "type": "object", "required": ["input_uncached", "input_total", "output", "cache_read", "cache_write", "reasoning"],
      "additionalProperties": {"$ref": "#/$defs/nullable_count"}
    },
    "amount": {"type": ["object", "null"], "required": ["value", "unit"], "properties": {"value": {"type": "string", "pattern": "^-?[0-9]+(\\.[0-9]+)?$"}, "unit": {"type": "string"}}},
    "basis": {"enum": ["priced_estimate", "settled_charge", "measured_resource", "unknown", "not_applicable"]},
    "occurred": {"$ref": "#/$defs/nullable_time"}, "received": {"type": "string", "format": "date-time"},
    "started": {"$ref": "#/$defs/nullable_time"}, "ended": {"$ref": "#/$defs/nullable_time"},
    "status": {"type": "string"}, "exit_reason": {"type": "string"},
    "coverage": {
      "type": "object", "required": ["state", "field_quality"],
      "properties": {
        "state": {"enum": ["live", "pending", "partial", "unattributed", "conflict", "closed_reconciled"]},
        "field_quality": {"type": "object", "additionalProperties": {"type": "string"}}
      }
    }
  },
  "if": {"properties": {"revises": {"type": "string"}}},
  "then": {"required": ["actor", "reason"]},
  "$defs": {
    "nullable_text": {"type": ["string", "null"]},
    "nullable_time": {"type": ["string", "null"], "format": "date-time"},
    "nullable_count": {"type": ["integer", "null"], "minimum": 0}
  }
}
```

## Sources and reconciliation

| Tier | Source and attribution |
| --- | --- |
| Core (Party Chairman) | Claude Code local request telemetry with the session transcript as cross-check. Bind to work explicitly or book as party overhead. Record observed execution intervals. |
| Spawner | Same local sources. Bind per request to work or repo overhead, with the dispatch's repo and spawner attribution. |
| Secretary | Count script time and exits by routed message. Record zero model calls for a script-only route only because that route forbids model calls. Count Jev direct calls and Terra calls through pi separately. Cross-check local Claude sessions during transition as in WP-110. |
| Mob | Use the same Claude request export for cloud mobs only if WP-111 proves it. Otherwise mob model spend is unknown, explicitly (plan 12 item 12). Git and PR receipts provide lifecycle evidence, not token counts. |
| Sprite | Capture final pi JSON usage events through the supervisor. Verify the Cursor fallback path separately. Attribute to the actual physical attempt, not the requested route. Missing fallback usage stays unknown (D11, WP-109). |
| Jockey | Use observed acknowledgement and decision times and explicit focus intervals or self-report. A human action is not a model call. Unmeasured attention is unknown. |

Prefer final request or response facts. Match Claude telemetry to transcript facts by native request and response ids; only a proven uncovered request can add a transcript fact. Dedupe within a producer and incarnation using native ids and ordinals, never `event.sequence` alone. For pi, use dispatch, incarnation and response ordinal, with native ids where available. Hold conflicts apart from known spend.

The sender fsyncs a spool and retries numbered batches. Acknowledge only durable ingress, with a contiguous batch watermark. Replay adds no spend. Track version changes, gaps, parse failures, mismatches, unmatched facts and late arrivals as source drift counters. Redact at source and again at ingress. Keep counted fields and sanitized evidence references, not prompts or credentials (plan 3.3 and 3.4; `sota-usage-tracking.md` section 4).

## Roll-ups

Each level separates own from inclusive totals. Own facts are booked directly at that level; inclusive totals include each descendant fact once. Never sum inclusive rows at adjacent levels (plan 3.4).

| Level | Envelope grouping and own spend |
| --- | --- |
| Sprite | `trace.execution_id` with `tier: sprite`; the sprite's execution facts. |
| Mob | `trace.execution_id` with `tier: mob`; includes sprites reached by `parent`. |
| Work item | `work_id` within `repo` and `party`; includes all matching `attempt` values. Own is direct work-item cost without an execution child in this roll-up. |
| Spawner | `trace.execution_id` for spawner facts; other facts join through the dispatch's immutable sponsor, not through the current repo owner. Include sponsored work and sponsored overhead. |
| Repo | `repo` within `party`; include its sponsored work, direct bookings and repo overhead. |
| Party | `party`; include repos, direct party overhead and unmatched facts known to belong to that party. Keep evidence with unknown party in a separate unmatched view. |

Book secretary cost by routed work or to repo overhead. Keep core overhead and unmatched records visible. A request covering several work items is booked once to overhead. Any apportionment is a labelled policy view, not extra spend. Reassignment does not move a charge.

The spawner scorecard shows tokens per merged PR, wakes per day, tokens per wake, and late or missed p0 and p1. Join wake receipts and merge evidence; expose spend coverage and never replace an unknown numerator with zero (plan 6.2 and 6.7).

## Limits and admission

Rules live at `limits.budgets` in [party configuration](swarm-party-config.md) (D22, plan 3.4 and 4).

| Rule fields | Meaning |
| --- | --- |
| `scope` | Party, repo, submitter, tier or work item, with the scoped id. |
| `dimension`, `window` | Unit and time base, for example one token bucket per subscription window, measured time per attempt, or a priced estimate per rolling window. |
| `warn`, `hard`, `action` | Warning and hard ceilings in that unit, and the configured response. A hard refusal blocks launch. |
| `missing_data_policy` | How to admit with missing or stale data. A strict rule needs a documented worst-case reserve or rejects admission. |
| `revision`, `actor`, `reason` | Compare-and-swap revision and audit for every edit. |
| `effective_at`, `expires_at` | When the rule takes effect and when it stops applying. |

A child cannot raise an ancestor's rule. Read current revisions on every admission and renewal, not cached board balances. A human override is scoped, expiring and audited. It does not change a provider limit.

Before launch, reserve against every applicable rule within one serialized ledger write. Require `committed + outstanding reserved + new reservation <= ceiling` for each scope, dimension and window. Keep the claim fence tied to the reservation. Recheck before retries or fallback launches. Consume a reservation once as usage arrives and release only verified unused capacity. Do not discard outstanding liability on lease expiry or window reset. A hard budget refuses a launch (WP-504). A strict rule that cannot bound a hosted run refuses that run rather than promising a mid-run cap.

Today `usageGuard` reads its usage source and refuses at a hard-coded 95 percent before reset (`packages/runtime/src/usage.ts:68`, `packages/runtime/src/usage.ts:71`, `packages/runtime/src/usage.ts:72`). WP-504 makes the ledger the reader's source, takes the stop percent from `limits.usage_stop_percent` (default 100, plan 4), and schedules one token-free wake after the window resets. The wake allows a fresh read, not an automatic admission on stale quota data. The reset wake does not invoke a model.

## Jockey control

The jockey can stop at every level of the roll-up and every scope of a limit: party, repo, spawner, submitter, tier, work item, mob and sprite attempt (D8, plan 3.4). A stop blocks new launches for its scope and asks the owner of each running execution to stop it.

| State | Evidence |
| --- | --- |
| Stop requested | The scoped stop is recorded. |
| Acknowledged | The controlling supervisor or operator confirms receipt. |
| Exited | The process or hosted session has verified terminal evidence. |
| Reconciled | Final usage is matched, unused reserve released, and any unrecoverable coverage remains explicitly unknown. |

A running cloud mob can be observed and stopped through hosted controls, not capped mid-run. A supported hard per-request stop for a cloud mob is unverified. A supervisor can stop the sprites it owns; that does not stop the parent mob. Archive or a killed heartbeat is never proof that spend stopped.

## What the board holds

The ledger is not in the board. The board holds task and claim identity, the current claim fence and claim status, party policy and control records, and spend projections. The ledger ties its reservation and envelope reference to the board id, task and claim epoch. The launch gate uses the confirmed board fence and the ledger reservation, not the projection.

No spend-specific board change is needed if the claim facts in [board additions](swarm-board-additions.md) give the dispatcher a stable attempt and claim fence. The fenced pending-dispatch record lives in the ledger; board-visible spend is a projection in channel posts and blocks, not a second reservation store (plan 3.1, 3.2 and 3.4).

## Work packages

| Package | Builds |
| --- | --- |
| WP-103 | Append-only ledger, envelopes, ingest, roll-ups and unknown handling. |
| WP-109 | pi supervisor and separate Cursor fallback capture check. |
| WP-110 | Claude Code local request capture with transcript cross-check. |
| WP-111 | Cloud canary: prove export or record failure and retain unknown mob spend. |
| WP-504 | Live usage-stop policy, token-free reset wake and hard reservation admission. |
| WP-701 | Coverage-aware scoring, outcome joins and scorecard views. |

See plan 7 and [reuse](swarm-reuse.md).

## Open

| Item | What remains open |
| --- | --- |
| Pricing inputs | A person supplies the subscription price and its window share. Confirm the billing scope and comparable window denominator; otherwise the estimate stays unknown. |
| Hosted evidence | WP-111 has not proved cloud telemetry (plan 12 item 12). Stop acknowledgement and proof of exit also need verification. |
| Plan 10 items 1, 2 and 4 | bonklek supplies the tunnel domain and Access rule, the Jev credential, and access to install services. These block only the named work or gate checks. |
| Coverage | The research leaves exact hosted VM metering, lost-export recovery and exact human attention unverified. Keep the gaps explicit. |
