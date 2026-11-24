import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

function parseAssignment(line) {
  const match = /^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/.exec(line)
  if (!match) throw new Error('expected NAME=VALUE')
  return [match[1], match[2]]
}

function escapeXml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
  return value.replace(/[&<>"']/g, (character) => entities[character])
}

function main() {
  let options
  let overrides
  try {
    options = parseArgs({
      options: {
        template: { type: 'string' },
        values: { type: 'string' },
        set: { type: 'string', multiple: true, default: [] },
        out: { type: 'string' },
      },
    }).values
    if (!options.template || !options.values || options.out === '') throw new Error()
    overrides = options.set.map(parseAssignment)
  } catch {
    console.error('usage: render-service.mjs --template <file> --values <file> [--set NAME=VALUE ...] [--out <file>]')
    return 2
  }

  const template = readFileSync(options.template, 'utf8')
  const placeholder = /\{\{([A-Za-z_][A-Za-z_0-9]*)\}\}/g
  const names = new Set(Array.from(template.matchAll(placeholder), ([, name]) => name))
  const values = new Map()
  for (const [index, line] of readFileSync(options.values, 'utf8').split(/\r?\n/).entries()) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    try {
      const [name, value] = parseAssignment(text)
      values.set(name, value)
    } catch {
      throw new Error(`invalid values file line ${index + 1}: expected NAME=VALUE`)
    }
  }
  for (const [name, value] of overrides) {
    if (!names.has(name)) throw new Error(`unknown --set name: ${name}`)
    values.set(name, value)
  }

  const plist = template.replace(placeholder, (_, name) => {
    if (!values.has(name)) throw new Error(`missing value for ${name}`)
    return escapeXml(values.get(name))
  })
  if (plist.includes('{{')) throw new Error('unreplaced placeholder in output')
  if (options.out) writeFileSync(options.out, plist)
  else process.stdout.write(plist)
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  console.error(`error: ${error.message}`)
  process.exitCode = 1
}
