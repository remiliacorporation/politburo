status: proposed
bonklek decides on this PR

# Party config

Each party (Party) keeps one versioned config tree on its party board (Standing Committee).
Core (Party Chairman) edits it, and the jockey (jockey) can pin any field.
The UI and agents edit the same record, with the same validation and audit.

## What it is

JSON and YAML are two forms of one schema-validated tree, not two different config stores. Core edits through settings or `swarm config`. All tiers read the effective tree; they do not keep independent copies of policy (D22, plan 4, WP-102, WP-405).

## Layering

Read built-in defaults, then the party tree on the party board, then an optional per-repo override stored on that repo's board (plan 4). The override applies only to that party on that repo.

Design choice: deep-merge objects, replace arrays rather than appending, and treat explicit null in a layer as a reset to the built-in field default, not inheritance from the immediately lower layer. This makes removal of a previous choice explicit and keeps name ordering predictable. Validate the layer before merging and validate the resolved tree again. If there is no default for an optional field, reset removes it.

Design choice: allow only repo-scoped policy keys in a repo override, so a shared repo board cannot redefine a party or its global settings.

| Keys | Repo override |
| --- | --- |
| `claims`, `review`, `trackers` | Yes. Tracker entries name only that repo. |
| `party`, `names` | No. Identity and name pools belong to the party. |
| `tiers`, `mail`, `secretary`, `setup` | No. The party owns how its tiers run and receive policy. |

## The tree

This is the default tree from plan 4. Ellipses mark data inputs the plan does not spell out; they are not shipped values. The first party's ID is `default` (plan 12 item 2). `party.id` stays stable and lowercase and is not a person's name. A key with no reader is not in the tree. Those keys are `labels`, `tiers.shares`, `tiers.models` other than `sprite`, `mail.urgency`, `secretary.questions.*.on_low_confidence`, `limits`, `heartbeat_minutes`, `setup.version`, and `setup.canary_environment`.

```yaml
party:
  id: default            # stable, lowercase; not a person's name
  name: "The People's Party"
  colour: "#b3261e"
names:                   # pools are ordered lists; first free name wins
  spawners: [ ... ]      # default: the current spawner pool
  secretaries: [Peggy, Joan, Dawn, Ida, ...]
  mob_species:           # by class and job, as in swarm-naming today
    passive: {audit: [COW, SHEEP, ...], research: [FOX, CAT, OCELOT], ...}
    neutral: {build: [BEE, DOLPHIN], fix: [WOLF, POLAR], ...}
    hostile: { ... }
    boss: [DRAGON, WITHER, WARDEN, ELDERG]
  sprite_items: {implement: [PICKAXE, AXE, ...], review: [SWORD, BOW, ...], ...}
tiers:
  models:
    sprite: {model: fallback/codex-cursor, thinking: medium}
mail:
  classes: [sec.push, sec.retry, sec.retire, sec.log, spawner.dispatch, spawner.decide, core.escalate, policy]
  digest_minutes: 30
secretary:
  questions:             # one entry per Jev question (section 6.3)
    can_wait: {enabled: false, prompt_version: 1, threshold: 0.97,
               late_p1_rate_limit: "1/500", state: shadow}
claims:
  hours: 4
  pause_on_downtime: false
  reclaim_cooldown_minutes: 15
  open_claims_per_repo: 2
  uncommitted_claims_per_repo: 1
  dock: {missed_claim: 1}
review:                  # the review policy and merge guardrail as rules
  docs_only: {model_review: false}
  code: {review_rounds: 1, fix_rounds: 1}
  merge_guardrail: {ci_on_exact_head: required, review_on_head: required, max_open_severity: minor}
setup:
  environment: politburo
trackers: {}             # per repo: sources and precedence (section 6.5)
                         # acme/web: {sources: [github, native], precedence: [github, native],
                         #            write: {comments: false, transitions: false}}
```

The loader ships ordered default pools as data from [Swarm naming](swarm-naming.md), [Swarm secretaries](swarm-secretaries.md#secretary-names) and the runtime `namePool` (`packages/runtime/src/names.ts:5`). First free wins within the right pool (plan 4). Policy and allocation logic do not name entries from those pools.

In the table, core edits each mutable field, and the jockey may pin any field. A pin does not make a stable identity mutable. For Jev, plan 6.3 also requires labels, actions, costly direction and a prompt; plan 4 shows only the initial `can_wait` row. Real thresholds come from shadow data (D17, plan 12 item 11).

| Key | Type | Default or source | Who changes it | Who reads it |
| --- | --- | --- | --- | --- |
| `party.id` | String | `default` for first party | Set at creation; stable thereafter | Registry and all record writers |
| `party.name`, `party.colour` | Strings | `The People's Party`, `#b3261e` | Core | UI, registry |
| `names.spawners`, `names.secretaries` | Ordered string arrays | Current pools, from the sources above | Core | Name allocator |
| `names.mob_species.passive`, `.neutral`, `.hostile` | Job to ordered string array | Naming data by class and job | Core | Mob name allocator |
| `names.mob_species.boss` | Ordered string array | Boss pool in naming data | Core | Mob name allocator |
| `names.sprite_items` | Job to ordered string array | Sprite naming data | Core | Sprite name allocator |
| `tiers.models.sprite.model`, `.thinking` | Strings | `fallback/codex-cursor`, `medium` | Core | Sprite launcher |
| `mail.classes` | Class array | The eight classes in the tree | Core | Mail admission and secretary service |
| `mail.digest_minutes` | Integer, minutes | `30` | Core | Secretary service |
| `secretary.questions.*.enabled`, `.state` | Boolean, enum | `false`, `shadow` in the sketch | Core sets policy; the service switches back on breach | Secretary service |
| `secretary.questions.*.prompt_version`, `.threshold` | Integer, number | `1`, `0.97` in the sketch | Core | Jev call and audit |
| `secretary.questions.*.late_p1_rate_limit` | Rate | `1/500` starting bar | Core within D17 | Secretary service |
| `secretary.questions.*.prompt`, `.labels`, `.actions`, `.costly_direction` | Prompt, label list, label to action, error direction | Per question, plan 6.3 | Core | Secretary service and review report |
| `claims.hours`, `.pause_on_downtime`, `.reclaim_cooldown_minutes` | Integer hours, boolean, integer minutes | `4`, `false`, `15` | Core within claim policy | Claim admission and enforcement |
| `claims.open_claims_per_repo`, `.uncommitted_claims_per_repo`, `.dock.missed_claim` | Integers | `2`, `1`, `1` | Core | Claim admission and scoring |
| `review.docs_only.model_review`, `review.code.review_rounds`, `.fix_rounds` | Boolean, integers | `false`, `1`, `1` | Core | Review gate |
| `review.merge_guardrail.ci_on_exact_head`, `.review_on_head`, `.max_open_severity` | Enums | `required`, `required`, `minor`: the guardrail of [swarm architecture](swarm-architecture.md#merge-guardrail) | Core | Review gate |
| `setup.environment` | String | `politburo` | Core | Setup and launcher |
| `trackers.<repo>.sources`, `.precedence` | Ordered lists | No sources by default | Core | Tracker adapters and work item reconciliation |
| `trackers.<repo>.write.comments`, `.write.transitions` | Booleans | `false`, `false`: reads first, comments before state changes (plan 6.5) | Core, per repo | Tracker adapters |

## Validation

Validate the resolved tree as draft 2020-12. The config service validates the whole tree with full JSON Schema. The board stores the tree as a block with a shallow registered schema (an object with a version and the tree), because the board's schema language is a subset without `$ref` or `pattern` (SPEC.md:1528-1537). Reject unknown keys at fixed levels; typed maps use data keys for jobs, labels in classifier answers and repo identifiers. Reject job keys not recognized by the allocator and mismatched classifier label/action keys in the config service. Validate repo override paths before merge. Numeric bounds validate the shape, not permission to change a fixed decision. Claims never pause on downtime (D20); p0 always forwards and is never classified (D17). Bounds below use the plan defaults, including 4 hours with a schema range of 1 to 24, and a 15-minute reclaim cooldown.

Design choice: use the named question keys below and give prompts, labels, actions and costly direction separate fields so audit can distinguish a prompt change from a routing change. Require those fields before a question can run. Model and tracker detail not fixed in plan 4 stays a schema sketch, not a provider contract.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["party", "names", "tiers", "mail", "secretary", "claims", "review", "setup", "trackers"],
  "properties": {
    "party": {
      "type": "object", "additionalProperties": false, "required": ["id", "name", "colour"],
      "properties": {"id": {"type": "string", "pattern": "^[a-z][a-z0-9-]*$", "default": "default"}, "name": {"$ref": "#/$defs/text"}, "colour": {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"}}
    },
    "names": {
      "type": "object", "additionalProperties": false, "required": ["spawners", "secretaries", "mob_species", "sprite_items"],
      "properties": {
        "spawners": {"$ref": "#/$defs/list"}, "secretaries": {"$ref": "#/$defs/list"}, "sprite_items": {"$ref": "#/$defs/pools"},
        "mob_species": {"type": "object", "additionalProperties": false, "required": ["passive", "neutral", "hostile", "boss"], "properties": {"passive": {"$ref": "#/$defs/pools"}, "neutral": {"$ref": "#/$defs/pools"}, "hostile": {"$ref": "#/$defs/pools"}, "boss": {"$ref": "#/$defs/list"}}}
      }
    },
    "tiers": {
      "type": "object", "additionalProperties": false, "required": ["models"],
      "properties": {
        "models": {"type": "object", "additionalProperties": false, "required": ["sprite"], "properties": {"sprite": {"type": "object", "additionalProperties": false, "required": ["model", "thinking"], "properties": {"model": {"$ref": "#/$defs/text"}, "thinking": {"$ref": "#/$defs/text"}}}}}
      }
    },
    "mail": {
      "type": "object", "additionalProperties": false, "required": ["classes", "digest_minutes"],
      "properties": {
        "classes": {"type": "array", "uniqueItems": true, "items": {"enum": ["sec.push", "sec.retry", "sec.retire", "sec.log", "spawner.dispatch", "spawner.decide", "core.escalate", "policy"]}},
        "digest_minutes": {"$ref": "#/$defs/positive", "default": 30}
      }
    },
    "secretary": {
      "type": "object", "additionalProperties": false, "required": ["questions"],
      "properties": {
        "questions": {
          "type": "object",
          "propertyNames": {"enum": ["intake_route", "needs_spawner", "can_wait", "urgency_match", "mob_report", "already_handled", "still_relevant", "handler", "outcomes_complete", "review_invariant"]},
          "additionalProperties": {"$ref": "#/$defs/question"}
        }
      }
    },
    "claims": {
      "type": "object", "additionalProperties": false,
      "required": ["hours", "pause_on_downtime", "reclaim_cooldown_minutes", "open_claims_per_repo", "uncommitted_claims_per_repo", "dock"],
      "properties": {
        "hours": {"type": "integer", "minimum": 1, "maximum": 24, "default": 4}, "pause_on_downtime": {"const": false, "default": false},
        "reclaim_cooldown_minutes": {"$ref": "#/$defs/count", "default": 15}, "open_claims_per_repo": {"$ref": "#/$defs/count", "default": 2}, "uncommitted_claims_per_repo": {"$ref": "#/$defs/count", "default": 1},
        "dock": {"type": "object", "additionalProperties": false, "required": ["missed_claim"], "properties": {"missed_claim": {"$ref": "#/$defs/count", "default": 1}}}
      }
    },
    "review": {
      "type": "object", "additionalProperties": false, "required": ["docs_only", "code"],
      "properties": {"docs_only": {"type": "object", "additionalProperties": false, "required": ["model_review"], "properties": {"model_review": {"type": "boolean"}}}, "code": {"type": "object", "additionalProperties": false, "required": ["review_rounds", "fix_rounds"], "properties": {"review_rounds": {"$ref": "#/$defs/count"}, "fix_rounds": {"$ref": "#/$defs/count"}}}, "merge_guardrail": {"type": "object", "additionalProperties": false, "required": ["ci_on_exact_head", "review_on_head", "max_open_severity"], "properties": {"ci_on_exact_head": {"enum": ["required"]}, "review_on_head": {"enum": ["required"]}, "max_open_severity": {"enum": ["none", "minor"]}}}}
    },
    "setup": {
      "type": "object", "additionalProperties": false, "required": ["environment"],
      "properties": {"environment": {"$ref": "#/$defs/text"}}
    },
    "trackers": {"type": "object", "propertyNames": {"pattern": "^[^/]+/[^/]+$"}, "additionalProperties": {"$ref": "#/$defs/tracker"}}
  },
  "$defs": {
    "text": {"type": "string", "minLength": 1},
    "list": {"type": "array", "items": {"$ref": "#/$defs/text"}},
    "pools": {"type": "object", "additionalProperties": {"$ref": "#/$defs/list"}},
    "count": {"type": "integer", "minimum": 0},
    "positive": {"type": "integer", "minimum": 1},
    "question": {
      "type": "object", "additionalProperties": false,
      "required": ["enabled", "prompt_version", "threshold", "late_p1_rate_limit", "state"],
      "properties": {
        "enabled": {"type": "boolean"}, "prompt_version": {"$ref": "#/$defs/positive"}, "threshold": {"type": "number", "minimum": 0, "maximum": 1},
        "late_p1_rate_limit": {"type": "string", "pattern": "^[0-9]+/[1-9][0-9]*$"}, "state": {"enum": ["shadow", "live", "off"]},
        "prompt": {"$ref": "#/$defs/text"}, "labels": {"$ref": "#/$defs/list"}, "actions": {"type": "object", "additionalProperties": {"$ref": "#/$defs/text"}}, "costly_direction": {"$ref": "#/$defs/text"}
      },
      "if": {"properties": {"enabled": {"const": true}}},
      "then": {"required": ["prompt", "labels", "actions", "costly_direction"]}
    },
    "tracker": {
      "type": "object", "additionalProperties": false, "required": ["sources", "precedence"],
      "properties": {"sources": {"$ref": "#/$defs/list"}, "precedence": {"$ref": "#/$defs/list"}, "write": {"type": "object", "additionalProperties": false, "properties": {"comments": {"type": "boolean", "default": false}, "transitions": {"type": "boolean", "default": false}}}}
    }
  }
}
```

## Reading and change notices

Every tier reads the tree at startup and on change. WP-503 sends one mail of class `policy` per affected mailbox per version through [Swarm mail](swarm-mail.md). A notice points to the committed version; a tier fetches and validates the record before acknowledging. The rollout ledger shows each tier that has not acknowledged the effective version, including a repo override version where applicable (plan 4, WP-209, WP-503).

## Audit and revert

Design choice: store each audit entry as a reply with a `swarm-config-change@1` block on the config thread, so a change can carry its full previous and proposed values beside the record. Include who, what, why, previous value, version and time. The config service records the verified editor; board `by` shows who wrote the reply. Revert in one step by writing the previous values as a new version. Never delete history (plan 4).

Design choice: commit a version by using a root version label that names the version number and its exact candidate reply. Post the candidate first, then compare-and-set the label from the exact prior value. Only the referenced candidate becomes current; it links to the previous committed candidate. A crash before the label write or a lost compare-and-set leaves an uncommitted proposal, not a second live version or a notice. This keeps the current version readable without requiring an atomic post-plus-label API. The board enforces grants and the atomic label `if` check, with 409 `label_conflict` on mismatch (`packages/board/src/server/writes.ts:855-892`). The swarm config service enforces tree validation, version ordering and pin checks against the same committed revision.

A pinned field refuses edits by anyone except the jockey; record the refusal without committing a version. A pin is advisory against any principal with direct write grant to the config channel. Only the config service principal and the jockey may write that channel, and the jockey uses the same service path for validated edits. Core submits through the service, not a direct board write. Apply the same grant boundary to the repo override record and do not treat an override as permission to bypass a party pin. See [board additions](swarm-board-additions.md) for any board-side integration needed to present these records through the handle.

## What nothing hard-codes

| Reader | Reads from config |
| --- | --- |
| UI and naming | Party name and colour, and all spawner, secretary, mob species and sprite item pools. |
| Dispatch and launch | The sprite model route and the setup environment. |
| Mail and secretary | Mail classes, digest minutes, Jev prompt versions and thresholds. |
| Claims and review | Claim hours, caps, cooldown, docks, review policy and merge guardrail. |
| Watch and trackers | Repo sources and precedence. |

Jev question keys in table order (plan 6.3): J1 `intake_route`, J2 `needs_spawner`, J3 `can_wait`, J4 `urgency_match`, J5 `mob_report`, J6 `already_handled`, J7 `still_relevant`, J8 `handler`, J9 `outcomes_complete`, J10 `review_invariant`. Read each question's state, prompt, fixed choices and actions from config. The D17 p0 bypass does not consult a model. The D17 automatic switch-back is a runtime safety stop, not an edit to a pinned field.

## Examples

This override raises the open-claim cap for `acme/web`, on that repo board for the party. Other claim fields inherit.

```yaml
claims:
  open_claims_per_repo: 3
```

This party edit changes the party name. Other parties keep theirs.

```yaml
party:
  name: Desk party
```

| Audit field | Repo override entry | Party entry |
| --- | --- | --- |
| Who | Verified core editor | Verified core editor |
| What | `claims.open_claims_per_repo` set to `3` on `acme/web` | `party.name` set to `Desk party` |
| Why | Allow three concurrent claims on this repo. | Use the party's preferred name. |
| Previous value | No override; inherited `2` | `The People's Party` |
| Version | Repo override version `1` | Party version `2` |
| Time | `2026-11-22T14:00:00Z` | `2026-11-22T14:05:00Z` |

## Open

- Found here: plan 4 leaves placeholders for the spawner pool and the setup digest. WP-102 must source real default data and WP-302 supplies the built digest. Tier model routes other than `sprite` are not in the tree, because nothing reads them.
- Found here: plan 2 lists UI labels. Nothing reads them, so `labels` is not in the tree. The merge guardrail and the tracker write switches stay as a Design choice; the tree above shows them.
- Found here: plan 6.3 needs per-question prompts, actions and shadow evidence but plan 4 only sketches `can_wait`. WP-205 supplies the remaining question data. WP-405 needs to prove pin and override changes on separate boards cannot race into an effective pinned-field change.
- Found here: `claims.pause_on_downtime` exists because plan 4 lists it, and the schema fixes it at `false` because D20 decides that claims never pause. The hours and the minutes are configuration (D22); the hard cutoff and the absence of a downtime pause are not.
- Found here: `limits` is not in the tree, because nothing reads it. [Spend](swarm-spend.md#limits-and-admission) still describes the budget shape. Score rules (WP-701) are not in this design's tree yet; WP-701 adds a `score` subtree.
