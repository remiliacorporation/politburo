import { questions } from '../classifier/questions.ts'
import defaults from './defaults.json' with { type: 'json' }
import schema from './schema.json' with { type: 'json' }

type SchemaNode = {
  [keyword: string]: unknown
  type?: string
  properties?: Record<string, SchemaNode>
  required?: string[]
  patternProperties?: Record<string, SchemaNode>
  items?: SchemaNode
  $ref?: string
  enum?: (string | number | boolean | null)[]
  pattern?: string
  minimum?: number
  maximum?: number
  minItems?: number
  minLength?: number
  uniqueItems?: boolean
}

const hidden = ['allOf', 'anyOf', 'oneOf', 'if', 'then', 'else']
const definitions = (schema as SchemaNode).definitions as Record<string, SchemaNode>

function deref(node: SchemaNode): SchemaNode {
  if (typeof node.$ref !== 'string') return node
  const name = node.$ref.split('/').pop()
  const found = name === undefined ? undefined : definitions[name]
  if (!found) throw new Error(`unresolved schema ref ${node.$ref}`)
  return found
}

function formatPath(parts: string[]): string {
  let out = ''
  for (const part of parts) {
    if (part === '[]') out += '[]'
    else out += (out ? '.' : '') + part
  }
  return out
}

type Key = { path: string; node: SchemaNode; required: boolean }

function partyConfigKeys(tree: SchemaNode = schema as SchemaNode): Key[] {
  const keys: Key[] = []
  const visit = (node: SchemaNode, parts: string[], required: readonly string[]) => {
    const resolved = deref(node)
    for (const keyword of hidden) {
      if (Object.hasOwn(resolved, keyword)) throw new Error(`schema keyword ${keyword} is not walked`)
    }
    if (resolved.properties) {
      for (const [key, child] of Object.entries(resolved.properties)) {
        const next = [...parts, key]
        keys.push({ path: formatPath(next), node: child, required: required.includes(key) })
        const childNode = deref(child)
        visit(child, next, childNode.required ?? [])
      }
    }
    if (resolved.patternProperties) {
      const child = Object.values(resolved.patternProperties)[0]
      if (!child) throw new Error(`empty patternProperties at ${formatPath(parts)}`)
      const next = [...parts, '*']
      keys.push({ path: formatPath(next), node: child, required: false })
      visit(child, next, deref(child).required ?? [])
    }
    if (resolved.type === 'array' && resolved.items) {
      const item = deref(resolved.items)
      if (item.properties || item.patternProperties || item.type === 'object') visit(item, [...parts, '[]'], item.required ?? [])
    }
  }
  visit(tree, [], tree.required ?? [])
  return keys
}

function typeLine(node: SchemaNode, required: boolean): string {
  const resolved = deref(node)
  const bits: string[] = []
  const names = (values: (string | number | boolean | null)[]) => values.map((value) => `\`${String(value)}\``).join(' | ')
  if (resolved.enum) bits.push(names(resolved.enum))
  else if (resolved.type === 'array') {
    const item = resolved.items ? deref(resolved.items) : undefined
    if (item?.enum) bits.push(`array of ${names(item.enum)}`)
    else if (item?.type === 'string') bits.push('string[]')
    else if (item?.properties || item?.type === 'object') bits.push('object[]')
    else bits.push('array')
    if (resolved.minItems !== undefined) bits.push(`at least ${resolved.minItems}`)
    if (resolved.uniqueItems) bits.push('unique')
    if (item?.minLength !== undefined) {
      bits.push(`each at least ${item.minLength} ${item.minLength === 1 ? 'character' : 'characters'}`)
    }
  } else if (resolved.type === 'integer' || resolved.type === 'number') {
    bits.push(resolved.type)
    if (resolved.minimum !== undefined) bits.push(`minimum ${resolved.minimum}`)
    if (resolved.maximum !== undefined) bits.push(`maximum ${resolved.maximum}`)
  } else if (resolved.type === 'string') {
    bits.push(resolved.pattern ? `string matching \`${resolved.pattern}\`` : 'string')
    if (resolved.minLength !== undefined) {
      bits.push(`at least ${resolved.minLength} ${resolved.minLength === 1 ? 'character' : 'characters'}`)
    }
  } else if (resolved.type === 'boolean') bits.push('boolean')
  else if (resolved.patternProperties) {
    const pattern = Object.keys(resolved.patternProperties)[0]
    bits.push(pattern ? `map, key matching \`${pattern}\`` : 'map')
  } else if (resolved.type === 'object' || resolved.properties) bits.push('object')
  else bits.push('value')
  if (required) bits.push('required')
  return bits.join(', ')
}

function splitPath(path: string): string[] {
  const parts: string[] = []
  for (const segment of path.split('.')) {
    if (segment.endsWith('[]')) parts.push(segment.slice(0, -2), '[]')
    else parts.push(segment)
  }
  return parts
}

function collect(value: unknown, parts: string[]): unknown[] {
  if (parts.length === 0) return [value]
  const [head, ...rest] = parts
  if (head === undefined) return []
  if (head === '[]') {
    if (!Array.isArray(value)) return []
    return value.flatMap((item) => collect(item, rest))
  }
  if (head === '*') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
    return Object.values(value).flatMap((item) => collect(item, rest))
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, head)) return []
  return collect((value as Record<string, unknown>)[head], rest)
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return `\`${value}\``
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return `\`${JSON.stringify(value)}\``
  const json = JSON.stringify(value)
  if (json.length <= 160) return `\`${json}\``
  return `\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
}

function defaultText(path: string): string {
  const values = collect(defaults, splitPath(path))
  if (values.length === 0) return 'Default: none'
  const encoded = values.map((value) => JSON.stringify(value))
  const same = encoded.every((value) => value === encoded[0])
  if (!same) {
    const json = JSON.stringify(values, null, 2)
    return `Default:\n\n\`\`\`json\n${json}\n\`\`\``
  }
  const text = formatValue(values[0])
  if (text.startsWith('\n') ) return `Default:${text}`
  return `Default: ${text}${values.length > 1 ? ' on each entry' : ''}`
}

const questionKeys = questions.map((question) => `\`${question.key}\``).join(', ')

const effects: Record<string, string> = {
  party: '`planMob` reads `party.id` from the loaded tree. `swarm party add` uses the built-in `name` and `colour` when the id is `default` and the matching flag is omitted.',
  'party.id': '`planMob` writes the loaded id into the mob brief.',
  'party.name': '`swarm party add` uses the built-in name when the id is `default` and `--name` is omitted.',
  'party.colour': '`swarm party add` uses the built-in colour when the id is `default` and `--colour` is omitted.',
  names: '`swarm alloc name` loads these pools and takes the first free name. `planMob` reads `mob_species` and `sprite_items`. `renderSkills` copies the mob and sprite pools into `skills/policy/SKILL.md`.',
  'names.spawners': '`allocateSpawnerName` and `swarm alloc name spawner` take the first free name in this order.',
  'names.secretaries': '`allocateSecretaryName` and `swarm alloc name secretary` take the first free name in this order.',
  'names.mob_species': '`allocateMobSpecies` and `planMob` read these pools. `renderSkills` copies each pool into `skills/policy/SKILL.md`.',
  'names.mob_species.passive': '`allocateMobSpecies` and `planMob` look here for a passive job. `renderSkills` copies each pool into `skills/policy/SKILL.md`.',
  'names.mob_species.neutral': '`allocateMobSpecies` and `planMob` look here for a neutral job. `renderSkills` copies each pool into `skills/policy/SKILL.md`.',
  'names.mob_species.hostile': '`allocateMobSpecies` and `planMob` look here for a hostile job. `renderSkills` copies each pool into `skills/policy/SKILL.md`.',
  'names.mob_species.boss': '`allocateMobSpecies` reads this pool for the `boss` job. `renderSkills` copies it into `skills/policy/SKILL.md`.',
  'names.sprite_items': '`allocateSpriteItem` and `planMob` read these pools. `renderSkills` copies each pool into `skills/policy/SKILL.md`.',
  tiers: '`swarm sprite routes` reads `tiers.models.sprite.routes`. `renderSkills` reads `tiers.models.sprite.thinking`.',
  'tiers.models': '`swarm sprite routes` reads `sprite.routes`. `renderSkills` reads `sprite.thinking`.',
  'tiers.models.sprite': '`swarm sprite routes` prints `routes`. `renderSkills` writes `thinking` into `skills/mob-creation/SKILL.md`.',
  'tiers.models.sprite.routes': '`swarm sprite routes` prints this array.',
  'tiers.models.sprite.routes[].label': '`swarm sprite routes` includes `label` on each printed route.',
  'tiers.models.sprite.routes[].provider': '`swarm sprite routes` includes `provider` on each printed route.',
  'tiers.models.sprite.routes[].model': '`swarm sprite routes` includes `model` on each printed route.',
  'tiers.models.sprite.thinking': '`renderSkills` writes this into `skills/mob-creation/SKILL.md`.',
  mail: '`createShadow` reads the built-in `classes` and `digest_minutes` when its options omit them. `replay` and `readFileMail` read the built-in class list.',
  'mail.classes': '`createShadow` uses the built-in class list when its options omit `classes`. `replay` draws synthetic classes from that list. `readFileMail` uses it when the caller omits classes.',
  'mail.digest_minutes': '`createShadow` uses the built-in digest interval, in minutes, when its options omit `digest_minutes`.',
  secretary: '`createClassifier` reads `secretary.questions` from the loaded tree.',
  'secretary.questions': `\`createClassifier\` reads this map and looks up ${questionKeys}.`,
  'secretary.questions.*': '`createClassifier` reads these fields for a question it knows.',
  'secretary.questions.*.enabled': '`createClassifier` wakes with reason `disabled` when this is false.',
  'secretary.questions.*.prompt_version': '`createClassifier` wakes with reason `invalid` unless this is `1`.',
  'secretary.questions.*.threshold': '`createClassifier` records reason `below_threshold` when the answer probability is below this.',
  'secretary.questions.*.late_p1_rate_limit': '`createClassifier` parses this as a costly-mistake limit and latches the question to `shadow` after a breach.',
  'secretary.questions.*.state': '`createClassifier` applies an answer only while the effective state is `live`. `shadow` wakes instead.',
  claims: '`createClaimRule` and `dockMisses` read the claims config they are given. `renderSkills` writes `hours` and `reclaim_cooldown_minutes` into `skills/policy/SKILL.md`. `scoreRules` reads `dock.missed_claim`.',
  'claims.hours': '`renderSkills` writes this into `skills/policy/SKILL.md` as the claim hard cutoff, in hours.',
  'claims.pause_on_downtime': '`createClaimRule` refuses to install a claim rule when this is true.',
  'claims.reclaim_cooldown_minutes': '`dockMisses` adds this many minutes to the cooldown. `renderSkills` writes it into `skills/policy/SKILL.md`. `createClaimRule` enforces the cooldown already recorded.',
  'claims.open_claims_per_repo': '`createClaimRule` refuses another claim when open claims reach this cap.',
  'claims.uncommitted_claims_per_repo': '`createClaimRule` refuses another claim when uncommitted claims reach this cap.',
  'claims.dock': '`dockMisses` and `scoreRules` read `missed_claim`.',
  'claims.dock.missed_claim': '`dockMisses` records this many points for a missed claim. `scoreRules` multiplies `score.missed_claim` by it.',
  review: '`renderSkills` writes the three leaves below into `skills/policy/SKILL.md`.',
  'review.docs_only': '`renderSkills` reads `model_review`.',
  'review.docs_only.model_review': '`renderSkills` writes this into `skills/policy/SKILL.md`.',
  'review.code': '`renderSkills` reads `review_rounds` and `fix_rounds`.',
  'review.code.review_rounds': '`renderSkills` writes this into `skills/policy/SKILL.md`.',
  'review.code.fix_rounds': '`renderSkills` writes this into `skills/policy/SKILL.md`.',
  score: '`scoreRules` copies this object from the loaded tree. `swarm score` loads that tree from `--rules`, or the built-in defaults when `--rules` is omitted. `scoreParty` applies the copied rules.',
  'score.state': '`scoreRules` copies this onto the rules. `scoreParty` and `swarm score` include it on the scorecard.',
  'score.merged_work': '`scoreParty` adds this many points for a stable verified merge.',
  'score.stays_merged_days': '`scoreParty` waits this many days after a merge before it counts as stable.',
  'score.revert': '`scoreParty` removes this many points when that work was reverted.',
  'score.review_round': '`scoreParty` removes this many points for each review round after the free rounds.',
  'score.free_review_rounds': '`scoreParty` leaves this many review rounds with no penalty.',
  'score.tokens_per_merged_pr': '`scoreParty` uses this object for the token penalty on a stable merge.',
  'score.tokens_per_merged_pr.target': '`scoreParty` counts tokens above this target toward the penalty.',
  'score.tokens_per_merged_pr.tokens_per_point': '`scoreParty` charges one penalty point per this many tokens over the target.',
  'score.tokens_per_merged_pr.max_penalty': '`scoreParty` caps the token penalty at this many points. Unknown spend on the merge uses the cap.',
  'score.human_minutes': '`scoreParty` uses this object for the human-minutes penalty.',
  'score.human_minutes.per_point': '`scoreParty` charges one penalty point per this many human minutes.',
  'score.human_minutes.max_penalty': '`scoreParty` caps the human-minutes penalty at this many points. A minutes fact with no count uses the cap.',
  'score.missed_claim': '`scoreParty` removes this many points per missed claim, after `scoreRules` multiplies it by `claims.dock.missed_claim`.',
  'score.unknown_spend': '`scoreParty` removes this many points for each unknown spend item.',
  'score.levels': '`levelFor` picks the last level whose `min` is less than or equal to the total.',
  'score.levels[].name': '`levelFor` returns this name on the chosen level.',
  'score.levels[].min': '`levelFor` compares the total with this minimum. `scoreRules` requires each minimum to be greater than the previous one.',
  'score.milestones': '`milestonesFor` marks each milestone reached or unmet.',
  'score.milestones[].id': '`milestonesFor` copies this id onto the scorecard. `scoreRules` rejects a duplicate id.',
  'score.milestones[].metric': '`milestonesFor` counts stable merges for `stable_merges`, and stable merges with reported spend for `fully_reported_merges`.',
  'score.milestones[].at': '`milestonesFor` reaches the milestone at this many matching merges.',
  setup: '`renderSkills` writes `environment` into `skills/mob-creation/SKILL.md`.',
  'setup.environment': '`renderSkills` writes this into `skills/mob-creation/SKILL.md` as the cloud environment name.',
  trackers: '`swarm trackers scan` reads `sources` and `precedence` for the repo key you name.',
  'trackers.*': '`swarm trackers scan` reads this entry when the repo argument matches the key.',
  'trackers.*.sources': '`swarm trackers scan` opens these source ids.',
  'trackers.*.precedence': '`swarm trackers scan` merges items in this order.',
}

function effect(path: string): string {
  const written = effects[path]
  if (written) return written
  const mob = /^names\.mob_species\.(passive|neutral|hostile)\.([a-z]+)$/.exec(path)
  if (mob?.[2]) {
    return `\`allocateMobSpecies\` and \`planMob\` take the first free name in this pool for the ${mob[2]} job. \`renderSkills\` copies the pool into \`skills/policy/SKILL.md\`.`
  }
  const sprite = /^names\.sprite_items\.([a-z]+)$/.exec(path)
  if (sprite?.[1]) {
    return `\`allocateSpriteItem\` and \`planMob\` take the first free name in this pool for the ${sprite[1]} job. \`renderSkills\` copies the pool into \`skills/policy/SKILL.md\`.`
  }
  throw new Error(`no effect written for ${path}`)
}

const example = `## Example

This party layer merges over the built-in defaults.

\`\`\`yaml
party:
  id: workshop
  name: Workshop
  colour: "#245c3d"
claims:
  hours: 2
  open_claims_per_repo: 1
mail:
  digest_minutes: 15
review:
  docs_only:
    model_review: true
score:
  state: shadow
secretary:
  questions:
    can_wait:
      enabled: false
      prompt_version: 1
      threshold: 0.97
      late_p1_rate_limit: "1/500"
      state: shadow
trackers:
  acme/web:
    sources:
      - github:acme/web
    precedence:
      - github:acme/web
\`\`\`

\`swarm config validate --party\` on this layer prints \`valid\`.
`

export function partyConfigReference(): string {
  const blocks = [
    '# Party config reference',
    '',
    'Generated from `src/config/schema.json` and `src/config/defaults.json` by `packages/swarm/scripts/write-party-config-reference.mjs`.',
    '',
    '`swarm config show` prints the merged tree. `swarm config validate` checks a party file, a repo file, or both. Built-in defaults load first. The party file deep-merges over them. The repo file deep-merges over that. Arrays replace. An unknown key fails validation.',
    '',
    'A `*` under `secretary.questions` is one question name. A `*` under `trackers` is one `owner/repo` key. `[]` is one object in an array.',
    '',
    '## Keys',
    '',
  ]
  for (const key of partyConfigKeys()) {
    blocks.push(`### \`${key.path}\``, '', `Type: ${typeLine(key.node, key.required)}`, '', defaultText(key.path), '', effect(key.path), '')
  }
  blocks.push(example.trimEnd())
  return `${blocks.join('\n')}\n`
}
