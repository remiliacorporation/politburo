---
title: Extension points
description: Plug party config, trackers, mail, sprites, skills, scoring, and work-item sources into the swarm package without editing its core, and what main does not do yet.
---

Start at [the swarm overview](../design/swarm-overview.md) for what the layer is. That page is not on `main` yet. This page is the catalog of plugs. It describes the code on `main`. Where a design note and the code disagree, the code wins.

Run every command from the checkout root after `pnpm install`. Mail samples import `@vercel/board`, so build that package too.

```bash
pnpm install
pnpm --filter @vercel/board build
```

## Party config keys

The party tree is one schema-validated object. `loadConfig` in [`packages/swarm/src/config/load.ts`](../packages/swarm/src/config/load.ts) reads built-in defaults, then an optional party layer, then an optional repo layer. Objects deep-merge. Arrays replace. Unknown fields at fixed levels fail. The schema is [`packages/swarm/src/config/schema.json`](../packages/swarm/src/config/schema.json). The defaults are [`packages/swarm/src/config/defaults.json`](../packages/swarm/src/config/defaults.json).

Without editing core you overlay keys the schema already has. `swarm config` and `swarm skills sync` are the readers on `main`. `swarm trackers scan` also reads `trackers`. Most other keys are stored and validated, then ignored.

To add a new top-level key or a new job in a name pool, edit the schema and the defaults. That is a core change. [Party config](../design/swarm-party-config.md) describes the intended tree. The loader does not yet restrict which keys a repo layer may set, and it does not treat `null` as a reset to the default.

Two maps are open. `secretary.questions` accepts any question key except `__proto__` and `constructor`. `trackers` accepts any repo key with the same exception.

Validate the shipped defaults:

```bash
node packages/swarm/src/cli.ts config validate
```

```text
valid
```

Overlay an existing key. The repo layer wins on the same field. Other defaults stay.

```bash
mkdir -p /tmp/swarm-ext
printf '%s\n' 'claims:' '  hours: 8' > /tmp/swarm-ext/party.yaml
printf '%s\n' 'claims:' '  hours: 12' > /tmp/swarm-ext/repo.yaml
node --input-type=module -e '
import { readFileSync } from "node:fs"
import { loadConfig, parseConfigText } from "./packages/swarm/src/config/load.ts"
const tree = loadConfig({
  party: parseConfigText(readFileSync("/tmp/swarm-ext/party.yaml", "utf8")),
  repo: parseConfigText(readFileSync("/tmp/swarm-ext/repo.yaml", "utf8")),
})
console.log(JSON.stringify({ hours: tree.claims.hours, cooldown: tree.claims.reclaim_cooldown_minutes }))
'
```

```text
{"hours":12,"cooldown":15}
```

Add a secretary question without touching the schema:

```bash
node --input-type=module -e '
import { loadConfig } from "./packages/swarm/src/config/load.ts"
const tree = loadConfig({
  party: {
    secretary: {
      questions: {
        extra_gate: {
          enabled: false,
          prompt_version: 1,
          threshold: 0.97,
          on_low_confidence: "wake",
          late_p1_rate_limit: "1/500",
          state: "shadow",
        },
      },
    },
  },
})
console.log(JSON.stringify(tree.secretary.questions.extra_gate))
'
```

```text
{"enabled":false,"prompt_version":1,"threshold":0.97,"on_low_confidence":"wake","late_p1_rate_limit":"1/500","state":"shadow"}
```

An unknown field is refused. The CLI prints the dotted path:

```bash
printf '%s\n' 'claims:' '  houres: 1' > /tmp/swarm-ext/bad.yaml
node packages/swarm/src/cli.ts config validate --party /tmp/swarm-ext/bad.yaml
```

```text
error: claims.houres: must NOT have additional properties
```

Test it: `pnpm --filter @remilia/politburo-swarm exec node --test test/config.test.ts test/cli.test.ts`.

## Tracker adapters

A tracker is a read-only source of issues. The plug is `TrackerAdapter` in [`packages/swarm/src/trackers/types.ts`](../packages/swarm/src/trackers/types.ts): `scan` pages observations, `get` fetches one ref. `scanTrackers` in [`packages/swarm/src/trackers/service.ts`](../packages/swarm/src/trackers/service.ts) walks adapters in precedence order and feeds [`mergeWorkItems`](../packages/swarm/src/trackers/merge.ts).

`main` ships `githubAdapter` and `linearAdapter`. Source ids are `github:<owner>/<repo>` and `linear:<TEAM>`. `swarm trackers scan` in [`packages/swarm/src/trackers/cli.ts`](../packages/swarm/src/trackers/cli.ts) builds only those two. A beads adapter is not on `main`. Writes are not on `main`: `TrackerError` names `write_disabled`, and no adapter writes.

`mergeWorkItems` calls `badge`, and `badge` calls `parseSourceId`. A custom `source` string that is not GitHub or Linear throws `bad_source` during merge. A custom adapter that you pass to `scanTrackers` must use a source id those two kinds accept, until `parseSourceId` and `badge` change.

A minimal adapter that `scanTrackers` will merge:

```bash
node --input-type=module <<'EOF'
import { scanTrackers } from './packages/swarm/src/trackers/index.ts'

const at = '2026-01-01T00:00:00Z'
const item = {
  ref: { source: 'github:acme/web', itemId: 'I_1', displayId: '1', url: 'https://example.invalid/1' },
  title: 'one issue', rawState: 'open', state: 'open', priority: 'none',
  labels: ['work:plb-1'], assignees: [], updatedAt: at, observedAt: at,
}
const { items, sources } = await scanTrackers({
  sources: [{ adapter: { source: 'github:acme/web', scan: async () => ({ items: [item], complete: true }), get: async () => item } }],
  precedence: ['github:acme/web'],
})
console.log(JSON.stringify({ key: items[0].key, badges: items[0].badges, state: items[0].state, sources }))
EOF
```

```text
{"key":"work:plb-1","badges":["GH#1"],"state":"open","sources":{"github:acme/web":{"status":"complete","pages":1}}}
```

A beads id is not a source kind:

```bash
node --input-type=module -e '
import { parseSourceId } from "./packages/swarm/src/trackers/index.ts"
try { parseSourceId("beads:rw"); console.log("accepted") }
catch (error) { console.log(error.reason) }
'
```

```text
bad_source
```

Test it: `pnpm --filter @remilia/politburo-swarm exec node --test test/trackers/merge.test.ts test/trackers/github.test.ts test/trackers/linear.test.ts`. The GitHub and Linear tests fake HTTP. They do not call the live APIs.

## Mail classes and routing

A mail root is a `swarm-message@1` block. Classes and urgencies are the closed lists in [`packages/swarm/src/mail/message.ts`](../packages/swarm/src/mail/message.ts): `MAIL_CLASSES` and `MAIL_URGENCIES`. `validateMessage` and the board schema both use those enums. `sendMail` posts the block with no labels. `createInbox` in [`packages/swarm/src/mail/inbox.ts`](../packages/swarm/src/mail/inbox.ts) admits unlabeled roots, writes `swarm.class`, `swarm.urgency`, and `swarm.state`, and serves the open queue. `createRelay` in [`packages/swarm/src/mail/relay.ts`](../packages/swarm/src/mail/relay.ts) delivers outbox roots whose `to` is `<board>/<channel>`.

Routing on `main` is urgency, not class. `readOpen` always returns every open p0, even when `limit` is 1, then fills the rest by urgency and `at`. p0 is not deduped on `[from, ref, class]`. p0 and p1 may not carry `expires`. p2 and p3 expire on read. The relay delivers p0, then p1, then p2, then p3, and waits for each urgency before the next.

Party config stores `mail.classes`, `mail.urgency`, and `mail.digest_minutes`. Nothing in `src/mail` reads that tree. Extra class names in config validate. They do not pass `validateMessage`. There is no class handler, no secretary service, and no `swarm-digest@1` writer on `main`. [Swarm mail](../design/swarm-mail.md) and [secretaries](../design/swarm-secretaries.md) describe those.

A class the contract accepts, and one it does not:

```bash
node --input-type=module -e '
import { validateMessage } from "./packages/swarm/src/mail/index.ts"
const base = {
  id: "ex-1", urgency: "p1", from: "attempt-1", ref: "plb-1",
  summary: "Need a name.", body: "See the findings.", at: "2026-11-20T21:14:00Z",
}
console.log(JSON.stringify({
  decide: validateMessage({ ...base, class: "spawner.decide" }, { now: new Date() }),
  custom: validateMessage({ ...base, class: "custom.foo" }, { now: new Date() }),
}))
'
```

```text
{"decide":[],"custom":["invalid_class"]}
```

Config still accepts a class name the contract will refuse:

```bash
node --input-type=module -e '
import { loadConfig } from "./packages/swarm/src/config/load.ts"
const tree = loadConfig({ party: { mail: { classes: ["sec.push", "custom.foo"] } } })
console.log(JSON.stringify(tree.mail.classes))
'
```

```text
["sec.push","custom.foo"]
```

Test it: `pnpm --filter @remilia/politburo-swarm exec node --test test/mail-inbox.test.ts test/mail-relay.test.ts`. Those tests run an in-process `local()` board. They fake no mail of the swarm's own.

## Sprite engine and model tiers

Sprites are `pi` helpers in [`packages/swarm/sprite/`](../packages/swarm/sprite/README.md). `pi-task` runs one task file. `sprite-start`, `sprite-watch`, and `sprite-stop` wrap it. The default model flag on `pi-task` is `fallback/codex-cursor`, thinking `medium`. That matches `tiers.models.sprite` in the defaults. `pi-task` does not read party config. It reads `PI_MODEL` and `PI_THINKING`.

The fallback router is [`packages/swarm/sprite/codex-cursor-fallback.ts`](../packages/swarm/sprite/codex-cursor-fallback.ts). `TIERS` is a closed list: work Codex, Cursor, personal Codex. `chooseRoute` walks that list and skips a tier in cooldown. You can change the Codex and Cursor model ids without editing `TIERS` by setting `PI_FALLBACK_PRIMARY_MODEL` and `PI_FALLBACK_CURSOR_MODEL`. Adding a fourth provider is a core change. The model catalog is [`packages/swarm/sprite/models-store.json`](../packages/swarm/sprite/models-store.json). Party `tiers.models` for core, spawner, mob, adviser, and classifier are not read by these helpers.

The helpers need Linux (`setsid`, `/proc`). `pi-task` with no file prints usage and exits 2:

```bash
packages/swarm/sprite/pi-task
```

```text
usage: pi-task <task-file> [max-seconds]
```

Test it: `pnpm --filter @remilia/politburo-swarm exec node --test test/sprite-helpers.test.ts`. That file installs a fake `pi` binary. It does not call a model.

## Skills generation

`renderSkills` in [`packages/swarm/src/skills/render.ts`](../packages/swarm/src/skills/render.ts) fills the templates under [`packages/swarm/skills/`](../packages/swarm/skills/). Placeholders are `{{path}}`, `{{join path}}`, and `{{yesno path}}`. `syncSkills` writes the result and marks each file `<!-- generated by swarm skills sync; edits are overwritten -->`. `swarm skills sync` loads party config, then syncs.

Without editing core you change the values the templates already print: labels, name pools, claim hours, review rounds, setup environment, sprite thinking. Adding a new skill file means adding its path to `paths` in `render.ts`. That is a core change. Sync refuses a destination whose git remotes match `tigeryard`, and it refuses generated text that contains that name.

Preview the default skills:

```bash
node packages/swarm/src/cli.ts skills sync --dir /tmp/swarm-ext/skills --dry-run
```

```text
would write  /tmp/swarm-ext/skills/mob-creation/SKILL.md
would write  /tmp/swarm-ext/skills/mob-creation/brief-template.md
would write  /tmp/swarm-ext/skills/spawner/SKILL.md
would write  /tmp/swarm-ext/skills/mob/SKILL.md
would write  /tmp/swarm-ext/skills/research/SKILL.md
would write  /tmp/swarm-ext/skills/reviewer/SKILL.md
would write  /tmp/swarm-ext/skills/policy/SKILL.md
```

Override a value the policy skill prints, then confirm the rendered file changes:

```bash
printf '%s\n' 'review:' '  code:' '    review_rounds: 7' '    fix_rounds: 1' > /tmp/swarm-ext/review.yaml
node --input-type=module -e '
import { readFileSync } from "node:fs"
import { loadConfig, parseConfigText } from "./packages/swarm/src/config/load.ts"
import { renderSkills } from "./packages/swarm/src/skills/render.ts"
const party = parseConfigText(readFileSync("/tmp/swarm-ext/review.yaml", "utf8"))
const stock = renderSkills(loadConfig()).get("policy/SKILL.md")
const custom = renderSkills(loadConfig({ party })).get("policy/SKILL.md")
const line = (text) => text.split("\n").find((row) => row.includes("review round"))
console.log(line(stock))
console.log(line(custom))
'
```

```text
- Code PRs: run 1 review round(s), at most 1 fix round(s), then a fixes-only re-review.
- Code PRs: run 7 review round(s), at most 1 fix round(s), then a fixes-only re-review.
```

Test it: `pnpm --filter @remilia/politburo-swarm exec node --test test/skills.test.ts`.

## Scoring rules

There is no scoring plug on `main`. [Party config](../design/swarm-party-config.md) says WP-701 adds a `score` subtree. The schema has no `score` key. `packages/swarm/src` has no scorer. The runtime scoreboard in `packages/runtime` scores model routes. That is not party scoring.

A `score` overlay is refused:

```bash
node --input-type=module -e '
import { loadConfig } from "./packages/swarm/src/config/load.ts"
try {
  loadConfig({ party: { score: { rules: [] } } })
  console.log("accepted")
} catch (error) {
  console.log(error.field + ": " + error.message)
}
'
```

```text
score: must NOT have additional properties
```

There is no scoring test to run. The config test above is the check.

## Work-item sources

A work item on `main` is the merge of tracker observations. Configure sources per repo under `trackers` in party config. `swarm trackers scan <repo>` reads that repo key, builds GitHub and Linear adapters, and prints merged rows.

Two observations become one work item when they share a single `work:<id>` label, or when you pass an `ExplicitLink` into `mergeWorkItems`. Unlinked issues stay separate, even with the same title. Precedence picks the winning state. A partial or failed source marks the item stale. Native board tasks are board tasks, not a tracker. Beads is not a source kind.

Point a repo key at GitHub, without calling GitHub:

```bash
node --input-type=module -e '
import { loadConfig } from "./packages/swarm/src/config/load.ts"
const tree = loadConfig({
  party: {
    trackers: {
      "acme/web": {
        sources: ["github:acme/web"],
        precedence: ["github:acme/web"],
      },
    },
  },
})
console.log(JSON.stringify(tree.trackers))
'
```

```text
{"acme/web":{"sources":["github:acme/web"],"precedence":["github:acme/web"]}}
```

`swarm trackers scan` against that tree would call GitHub. Do not run it here. The merge example under [Tracker adapters](#tracker-adapters) is the source join without a network.

The tag registry [`packages/swarm/registry/tags.json`](../packages/swarm/registry/tags.json) is data. It is not a work-item source. Work ids such as `plb-1` use those tags. Adding a tag means editing that file.

Test it: `pnpm --filter @remilia/politburo-swarm exec node --test test/trackers/merge.test.ts test/trackers/cli.test.ts`. The CLI test fakes GitHub and Linear.

## Add a command

A command is one new file, `packages/swarm/src/commands/<name>.ts`. The filename is the command name. The file exports `name`, `summary`, and `run(argv)`. `src/cli.ts` reads that directory and loads the one file it was asked for. It does not keep a command list.

```ts
export const name = 'ping'
export const summary = 'ping'
export function run(argv: string[]): number {
  console.log(argv.length === 0 ? 'pong' : 'usage: swarm ping')
  return argv.length === 0 ? 0 : 2
}
```

`node packages/swarm/src/cli.ts ping` runs it from source. The same file is in `dist/commands/` after `tsc`.

A public export is a new file `packages/swarm/src/public/<area>.ts` that star-exports the feature. The package scripts write `src/index.generated.ts` from that directory before `tsc`. `src/index.ts` star-exports only that generated file. A command note is a new file in `packages/swarm/docs/`. None of these edits `cli.ts`, `index.ts`, or `README.md`.

## What is not a plug yet

| Design | On `main` |
| --- | --- |
| Repo overrides limited to `claims`, `review`, `trackers`, `limits` | Any valid key in a repo layer merges |
| Tracker writes (`comments`, `transitions`) | Read-only `scan` and `get` |
| Beads, native board tasks as sources | GitHub Issues and Linear only |
| Mail class handlers and the digest | Urgency queue and relay only |
| Party `mail.*` and `tiers.models` driving send, admit, or `pi-task` | Config and skills templates only |
| Score rules | No `score` key |
| New skill files, new `MAIL_CLASSES`, new `TIERS`, new `SourceKind` | Edit those closed lists |

[Reuse](../design/swarm-reuse.md) says which packages already exist. [The merger](../design/swarm-merger.md) is the package boundary. [Work items](../design/swarm-work-items.md) is the outcomes contract, which this package does not yet validate.
