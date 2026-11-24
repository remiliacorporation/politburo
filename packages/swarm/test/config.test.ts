import assert from 'node:assert/strict'
import test from 'node:test'
import { stringify } from 'yaml'
import defaultsJson from '../src/config/defaults.json' with { type: 'json' }
import schemaJson from '../src/config/schema.json' with { type: 'json' }
import { ConfigError, defaultConfig, loadConfig, parseConfigText, validateConfig } from '../src/index.ts'

function schemaPropertyKeys(node: Record<string, any>, path = ''): string[] {
  const properties = node.properties
  if (properties === undefined || typeof properties !== 'object' || properties === null) return []
  const keys: string[] = []
  for (const [name, child] of Object.entries(properties) as [string, any][]) {
    const next = path ? `${path}.${name}` : name
    keys.push(next)
    if (child && typeof child === 'object') keys.push(...schemaPropertyKeys(child, next))
  }
  return keys
}

function objectKeys(value: unknown, path = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const keys: string[] = []
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    const next = path ? `${path}.${name}` : name
    keys.push(next)
    keys.push(...objectKeys(child, next))
  }
  return keys
}

test('defaults are invalid or change through a JSON or YAML round trip', () => {
  const tree = defaultConfig()
  validateConfig(tree)
  assert.deepEqual(parseConfigText(JSON.stringify(tree)), tree)
  assert.deepEqual(parseConfigText(stringify(tree)), tree)
})

test('a misspelled party field is accepted or reported at the wrong path', () => {
  assert.throws(
    () => loadConfig({ party: { claims: { houres: 1 } } }),
    (error) => {
      assert.ok(error instanceof ConfigError)
      assert.equal(error.field, 'claims.houres')
      return true
    },
  )
})

test('unknown jobs are accepted in mob or sprite name pools', () => {
  for (const kind of ['passive', 'neutral', 'hostile']) {
    const party = { names: { mob_species: { [kind]: { typo: ['X'] } } } }
    assert.throws(() => loadConfig({ party }), { name: 'ConfigError', field: `names.mob_species.${kind}.typo` })
  }
  const party = { names: { sprite_items: { typo: ['X'] } } }
  assert.throws(() => loadConfig({ party }), { name: 'ConfigError', field: 'names.sprite_items.typo' })
})

test('a missing tracker field hides an unknown field', () => {
  const tree = defaultConfig()
  tree.trackers = { acme: { typo: true } }
  assert.throws(() => validateConfig(tree), { name: 'ConfigError', field: 'trackers.acme.typo' })
})

test('a repo replacement hides an unknown field in the party layer', () => {
  const party = { tiers: { models: { sprite: { typo: 1 } } } }
  const repo = { tiers: { models: { sprite: { thinking: 'low' } } } }
  assert.throws(() => loadConfig({ party, repo }), { name: 'ConfigError', field: 'tiers.models.sprite.typo' })
})

test('duplicate config keys are accepted or not diagnosed', () => {
  for (const text of ['{"claims":{},"claims":{}}', 'claims: {}\nclaims: {}\n']) {
    assert.throws(() => parseConfigText(text), { name: 'ConfigError', field: '', message: /duplicate key/i })
  }
})

test('a non-integer claim duration is accepted or reported at the wrong path', () => {
  assert.throws(
    () => loadConfig({ party: { claims: { hours: 'invalid' } } }),
    (error) => {
      assert.ok(error instanceof ConfigError)
      assert.equal(error.field, 'claims.hours')
      return true
    },
  )
})

test('layers apply out of order, append to an array, or drop untouched defaults', () => {
  const defaults = defaultConfig()
  const partyHours = defaults.claims.hours + 1
  const repoHours = partyHours + 1
  const partyCooldown = defaults.claims.reclaim_cooldown_minutes + 1
  const tree = loadConfig({
    party: {
      claims: { hours: partyHours, reclaim_cooldown_minutes: partyCooldown },
      names: { mob_species: { boss: ['custom'] } },
    },
    repo: { claims: { hours: repoHours } },
  })
  assert.equal(tree.claims.hours, repoHours)
  assert.equal(tree.claims.reclaim_cooldown_minutes, partyCooldown)
  assert.deepEqual(tree.names.mob_species.boss, ['custom'])
  assert.equal(tree.review.docs_only.model_review, defaults.review.docs_only.model_review)
  assert.deepEqual(tree.setup, defaults.setup)
})

test('a duplicate boss name is accepted or reported outside its pool', () => {
  assert.throws(
    () => loadConfig({ party: { names: { mob_species: { boss: ['custom', 'custom'] } } } }),
    (error) => error instanceof ConfigError && /^names\.mob_species\.boss(?:\.|$)/.test(error.field),
  )
})

test('mutating a returned name pool leaks into the next default tree', () => {
  const tree = defaultConfig()
  const names = [...tree.names.mob_species.boss]
  tree.names.mob_species.boss.length = 0
  assert.deepEqual(defaultConfig().names.mob_species.boss, names)
})

test('a schema property has no default, or a default is missing from the schema', () => {
  assert.deepEqual(schemaPropertyKeys(schemaJson).sort(), objectKeys(defaultsJson).sort())
})
