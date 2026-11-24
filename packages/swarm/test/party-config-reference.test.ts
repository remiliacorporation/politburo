import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

type SchemaNode = {
  [keyword: string]: unknown
  type?: string
  properties?: Record<string, SchemaNode>
  required?: string[]
  patternProperties?: Record<string, SchemaNode>
  items?: SchemaNode
  $ref?: string
}

const hidden = ['allOf', 'anyOf', 'oneOf', 'if', 'then', 'else']

function formatPath(parts: string[]): string {
  let out = ''
  for (const part of parts) {
    if (part === '[]') out += '[]'
    else out += (out ? '.' : '') + part
  }
  return out
}

function schemaKeys(tree: SchemaNode, definitions: Record<string, SchemaNode>): string[] {
  const deref = (node: SchemaNode): SchemaNode => {
    if (typeof node.$ref !== 'string') return node
    const name = node.$ref.split('/').pop()
    const found = name === undefined ? undefined : definitions[name]
    if (!found) throw new Error(`unresolved schema ref ${node.$ref}`)
    return found
  }
  const keys: string[] = []
  const visit = (node: SchemaNode, parts: string[]) => {
    const resolved = deref(node)
    for (const keyword of hidden) {
      if (Object.hasOwn(resolved, keyword)) throw new Error(`schema keyword ${keyword} is not walked`)
    }
    if (resolved.properties) {
      for (const [key, child] of Object.entries(resolved.properties)) {
        const next = [...parts, key]
        keys.push(formatPath(next))
        visit(child, next)
      }
    }
    if (resolved.patternProperties) {
      const child = Object.values(resolved.patternProperties)[0]
      if (!child) throw new Error(`empty patternProperties at ${formatPath(parts)}`)
      const next = [...parts, '*']
      keys.push(formatPath(next))
      visit(child, next)
    }
    if (resolved.type === 'array' && resolved.items) {
      const item = deref(resolved.items)
      if (item.properties || item.patternProperties || item.type === 'object') visit(item, [...parts, '[]'])
    }
  }
  visit(tree, [])
  return keys
}

test('the party config reference omits a schema key or its example fails validation', () => {
  const schema = JSON.parse(readFileSync(new URL('../src/config/schema.json', import.meta.url), 'utf8')) as SchemaNode
  const definitions = schema.definitions as Record<string, SchemaNode>
  const doc = readFileSync(new URL('../docs/party-config-reference.md', import.meta.url), 'utf8')
  const missing = schemaKeys(schema, definitions).filter((path) => !doc.split('\n').includes(`### \`${path}\``))
  assert.deepEqual(missing, [])

  const example = doc.split(/^## Example$/m)[1]?.match(/```yaml\n([\s\S]*?)```/)?.[1]
  assert.ok(example)
  const dir = mkdtempSync(join(tmpdir(), 'swarm-party-config-'))
  try {
    const party = join(dir, 'party.yaml')
    writeFileSync(party, example)
    const result = spawnSync(process.execPath, ['src/cli.ts', 'config', 'validate', '--party', party], {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
    })
    if (result.error) throw result.error
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'valid\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
