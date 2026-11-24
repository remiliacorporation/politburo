import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { stringify } from 'yaml'
import { ConfigError, defaultConfig, loadConfig, parseConfigText, validateConfig } from '../src/index.ts'

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

test('a missing required field hides an unknown field', () => {
  const tree = defaultConfig()
  tree.score.human_minutes = { typo: true }
  assert.throws(() => validateConfig(tree), { name: 'ConfigError', field: 'score.human_minutes.typo' })
})

test('a repo replacement hides an unknown field in the party layer', () => {
  const party = { score: { human_minutes: { typo: 1 } } }
  const repo = { score: { human_minutes: { per_point: 1, max_penalty: 1 } } }
  assert.throws(() => loadConfig({ party, repo }), { name: 'ConfigError', field: 'score.human_minutes.typo' })
})

test('every example config loads', () => {
  const dir = new URL('../examples/', import.meta.url)
  const names = readdirSync(dir).filter((name) => /\.(ya?ml|json)$/.test(name))
  assert.ok(names.length > 0)
  for (const name of names) {
    try {
      loadConfig({ party: parseConfigText(readFileSync(new URL(name, dir), 'utf8')) })
    } catch (error) {
      const field = error instanceof ConfigError ? ` (${error.field})` : ''
      assert.fail(`${name}${field}: ${error instanceof Error ? error.message : error}`)
    }
  }
})

test('a config that sets a removed key fails validation', () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ labels: { product: 'Desk' } }, 'labels'],
    [{ tiers: { shares: { core: 1 } } }, 'tiers.shares'],
    [{ tiers: { models: { core: 'inherit' } } }, 'tiers.models.core'],
    [{ tiers: { models: { spawner: 'inherit' } } }, 'tiers.models.spawner'],
    [{ tiers: { models: { mob: 'inherit' } } }, 'tiers.models.mob'],
    [{ tiers: { models: { adviser: 'model' } } }, 'tiers.models.adviser'],
    [{ tiers: { models: { classifier: 'model' } } }, 'tiers.models.classifier'],
    [{ mail: { urgency: { p0: 'forward_now' } } }, 'mail.urgency'],
    [{ secretary: { questions: { can_wait: { on_low_confidence: 'wake' } } } }, 'secretary.questions.can_wait.on_low_confidence'],
    [{ limits: { usage_stop_percent: 100 } }, 'limits'],
    [{ heartbeat_minutes: 30 }, 'heartbeat_minutes'],
    [{ setup: { version: { id: 'v11', sha256: null } } }, 'setup.version'],
    [{ setup: { canary_environment: 'politburo-canary' } }, 'setup.canary_environment'],
  ]
  for (const [party, field] of cases) {
    assert.throws(() => loadConfig({ party }), { name: 'ConfigError', field })
  }
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
      names: { spawners: ['custom'] },
    },
    repo: { claims: { hours: repoHours } },
  })
  assert.equal(tree.claims.hours, repoHours)
  assert.equal(tree.claims.reclaim_cooldown_minutes, partyCooldown)
  assert.deepEqual(tree.names.spawners, ['custom'])
  assert.equal(tree.claims.pause_on_downtime, defaults.claims.pause_on_downtime)
  assert.deepEqual(tree.party, defaults.party)
})

test('a duplicate spawner name is accepted or reported outside its pool', () => {
  assert.throws(
    () => loadConfig({ party: { names: { spawners: ['custom', 'custom'] } } }),
    (error) => error instanceof ConfigError && /^names\.spawners(?:\.|$)/.test(error.field),
  )
})

test('mutating a returned name pool leaks into the next default tree', () => {
  const tree = defaultConfig()
  const names = [...tree.names.spawners]
  tree.names.spawners.length = 0
  assert.deepEqual(defaultConfig().names.spawners, names)
})
