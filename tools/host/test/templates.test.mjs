import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ops = new URL('../../../design/ops-templates/', import.meta.url)
const launchd = new URL('launchd/', ops)
const values = new URL('values.example', ops)
const renderer = fileURLToPath(new URL('../render-service.mjs', import.meta.url))
const templatePath = (name) => fileURLToPath(new URL(`${name}.plist.template`, launchd))
const templates = new Map(readdirSync(launchd)
  .filter((name) => name.endsWith('.plist.template'))
  .map((file) => [file.replace(/\.plist\.template$/, ''), readFileSync(new URL(file, launchd), 'utf8')]))
const example = readFileSync(values, 'utf8')

function render(name, ...args) {
  return spawnSync(process.execPath, [renderer, '--template', templatePath(name),
    '--values', fileURLToPath(values), ...args], { encoding: 'utf8' })
}

// Catches broken XML, incomplete substitution, or a renderer that mishandles overrides or usage.
test('render plists and diagnose bad inputs', async (t) => {
  const plists = new Map()
  for (const name of templates.keys()) {
    const result = render(name)
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stdout, /\{\{/, name)
    plists.set(name, result.stdout)
  }

  const dir = mkdtempSync(join(tmpdir(), 'render-plist-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const out = join(dir, 'board-party.plist')
  const override = render('board-party', '--set', `NODE=/opt/a&b<'">/node`, '--set', 'PORT_PARTY=4201', '--out', out)
  assert.equal(override.status, 0, override.stderr)
  assert.equal(override.stdout, '')
  const overridden = readFileSync(out, 'utf8')
  assert.ok(overridden.includes('<string>/opt/a&amp;b&lt;&apos;&quot;&gt;/node</string>'))
  assert.ok(overridden.includes('<string>4201</string>'))
  plists.set('board-party with overrides', overridden)

  const unknown = render('board-party', '--set', 'PORT_REPO=4202')
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /unknown --set name: PORT_REPO/)
  const missing = render('board-party', '--values', '/dev/null')
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /missing value for LABEL_PREFIX/)
  assert.equal(render('board-party', '--set', 'NODE').status, 2)

  // Catches malformed XML that still renders with exit 0.
  await t.test('xmllint checks the rendered XML', (lint) => {
    for (const [name, xml] of plists) {
      const result = spawnSync('xmllint', ['--nonet', '--noout', '-'], { input: xml, encoding: 'utf8' })
      if (result.error?.code === 'ENOENT') {
        lint.skip('xmllint is not installed; XML well-formedness was not checked')
        return
      }
      assert.ifError(result.error)
      assert.equal(result.status, 0, `${name}: ${result.stderr}`)
    }
  })
})

// Catches a value declaration that no template uses, or a template using an undeclared name.
test('templates and values.example declare the same placeholders', () => {
  const declared = new Set(Array.from(example.matchAll(/^([A-Z_0-9]+)=/gm), ([, name]) => name))
  const used = new Set(Array.from([...templates.values()].join('\n').matchAll(/\{\{([A-Z_0-9]+)\}\}/g), ([, name]) => name))
  assert.deepEqual(declared, used)
})

// Catches credential-like fields, private paths or addresses, and non-allowlisted plist environment keys.
test('templates and examples contain only public deployment settings', () => {
  for (const [name, text] of [...templates, ['values.example', example]]) {
    assert.ok(!/(^|[^a-z0-9])(?:token|secret|password|apikey|api_key)(?![a-z0-9])/i.test(text), `${name} contains a credential-like field`)
    assert.ok(!/\/(?:Users|home)\//.test(text), `${name} contains an absolute home path`)
    assert.ok(!/\.(?:local|ts\.net)\b/i.test(text), `${name} contains a private hostname`)
    for (const [address] of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
      assert.ok(address === '127.0.0.1', `${name} contains a non-loopback IPv4 address`)
    }
    for (const [, env] of text.matchAll(/<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/g)) {
      const keys = Array.from(env.matchAll(/<key>\s*([^<]*?)\s*<\/key>/g), ([, key]) => key)
      assert.ok(keys.every((key) => key === 'PATH' || key === 'HOME'), `${name} has a non-allowlisted environment key`)
    }
  }
})

// Catches missing services or launchd settings that would break supervision, scheduling, or log capture.
test('long-running daemons restart and scheduled jobs do not', () => {
  const daemons = ['board-party', 'board-repo', 'relay', 'secretary', 'ledger', 'mirror', 'watch']
  const scheduled = ['backup', 'rotate-logs']
  assert.deepEqual(new Set(templates.keys()), new Set([...daemons, ...scheduled]))
  for (const name of daemons) {
    const text = templates.get(name)
    assert.match(text, /<key>UserName<\/key>\s*<string>\{\{\w+\}\}<\/string>/, name)
    assert.match(text, /<key>KeepAlive<\/key>\s*<true\/>/, name)
    assert.match(text, /<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/, name)
    assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/, name)
    for (const stream of ['StandardOutPath', 'StandardErrorPath']) {
      assert.ok(text.match(new RegExp(`<key>${stream}</key>\\s*<string>([^<]+)</string>`))?.[1] ===
        `{{LOG_ROOT}}/${name}.log`, `${name} ${stream}`)
    }
  }
  for (const name of scheduled) {
    const text = templates.get(name)
    assert.match(text, /<key>StartCalendarInterval<\/key>\s*<dict>/, name)
    assert.doesNotMatch(text, /<key>KeepAlive<\/key>/, name)
    assert.match(text, /<key>RunAtLoad<\/key>\s*<false\/>/, name)
  }
})
