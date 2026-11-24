import Ajv, { type ErrorObject } from 'ajv'
import { parseDocument, visit } from 'yaml'
import defaults from './defaults.json' with { type: 'json' }
import schema from './schema.json' with { type: 'json' }

export type PartyConfig = Record<string, any>

export class ConfigError extends Error {
  field: string

  constructor(field: string, message: string) {
    super(message)
    this.name = 'ConfigError'
    this.field = field
  }
}

const validate = new Ajv.default({ allErrors: true, ownProperties: true }).compile(schema)

export function defaultConfig(): PartyConfig {
  return structuredClone(defaults)
}

export function parseConfigText(text: string): unknown {
  const doc = parseDocument(text)
  const error = doc.errors[0]
  if (error) throw new ConfigError('', error.code === 'DUPLICATE_KEY' ? 'duplicate key' : 'invalid YAML or JSON')
  visit(doc, {
    Alias() {
      throw new ConfigError('', 'aliases are not allowed')
    },
  })
  return doc.toJS()
}

function unknownField() {
  return validate.errors?.find((error) => error.keyword === 'additionalProperties')
}

function configError(error: ErrorObject): ConfigError {
  const path = error.instancePath
    .split('/')
    .slice(1)
    .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'))
  if (error.keyword === 'additionalProperties') {
    path.push(error.params.additionalProperty)
  } else if (error.keyword === 'required') {
    path.push(error.params.missingProperty)
  }
  return new ConfigError(path.join('.'), error.message ?? 'invalid value')
}

export function validateConfig(tree: unknown): asserts tree is PartyConfig {
  if (!validate(tree)) throw configError(unknownField() ?? validate.errors![0]!)
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function merge(base: unknown, layer: unknown): unknown {
  if (!isObject(base) || !isObject(layer)) return layer
  const entries = Object.entries(layer).map(([key, value]) => [
    key,
    Object.hasOwn(base, key) ? merge(base[key], value) : value,
  ])
  return { ...base, ...Object.fromEntries(entries) }
}

export function loadConfig(layers: { party?: unknown; repo?: unknown } = {}): PartyConfig {
  let tree: unknown = defaultConfig()
  for (const layer of [layers.party, layers.repo]) {
    if (layer === undefined) continue
    validate(layer)
    const error = unknownField()
    if (error) throw configError(error)
    tree = merge(tree, layer)
  }
  validateConfig(tree)
  return tree
}
