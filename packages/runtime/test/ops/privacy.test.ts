import assert from 'node:assert/strict'
import { test } from 'node:test'
import { preflight, scanDiff } from '../../src/ops/privacy.ts'

function added(lines: string[], file = 'config.txt') {
  return ['--- /dev/null', `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => '+' + line)].join('\n')
}

const sample = 'fixture-' + 'only-42'
const person = 'fixture.person' + '@' + 'example.test'
const githubNoreply = '123+fixture' + '@' + 'users.noreply.github.com'
const orgNoreply = 'noreply' + '@' + 'example.test'
const github = 'ghp_' + 'z'.repeat(36)
const npm = 'npm_' + 'q'.repeat(36)
const privateKey = '-----BEGIN ' + 'OPENSSH PRIVATE KEY' + '-----'
const fineGrained = 'github_pat_' + 'z'.repeat(22) + '_' + 'z'.repeat(59)

for (const [label, rule, text] of [
  ['GitHub classic', 'github-token', github],
  ['GitHub fine-grained', 'github-token', fineGrained],
  ['npm', 'npm-token', npm],
  ['Slack', 'slack-token', 'xoxb-' + '0000000000-0000000000-fixture'],
  ['AWS', 'aws-access-key', 'AKIA' + 'Z'.repeat(16)],
  ['private key', 'private-key', privateKey],
  ['API key assignment', 'secret-assignment', 'API_KEY' + '=' + sample],
  ['secret assignment', 'secret-assignment', '"client_secret"' + ': "' + sample + '"'],
  ['password assignment', 'secret-assignment', 'password' + ' = \'' + sample + '\''],
  ['email', 'email', person],
] as const) {
  test(`reports a redacted ${label} finding`, () => {
    const findings = scanDiff(added([text]))
    assert.deepEqual(findings, [{ rule, file: 'config.txt', line: 1, match: '[redacted]' }])
  })
}

test('ignores removed lines, context, headers, and text outside a hunk', () => {
  const input = [
    'diff --git a/fixture b/fixture',
    '--- a/fixture',
    `+++ b/${github}`, // Paths are not scanned for findings.
    `@@ -1,2 +1 @@ ${person}`,
    ` ${npm}`,
    `-${privateKey}`,
    `+${person}`, // The hunk is already over.
  ].join('\n')
  assert.deepEqual(scanDiff(input), [])
})

test('locates additions across files and hunks, including a line starting with three pluses', () => {
  const input = [
    'diff --git a/old.txt b/new name.txt',
    '--- a/old.txt',
    '+++ b/new name.txt\t',
    '@@ -30,3 +50,3 @@',
    '-removed',
    ' old context',
    `+++ ${person}`,
    ' trailing context',
    '@@ -80 +90 @@',
    '-removed',
    '\\ No newline at end of file',
    `+${npm}`,
    '\\ No newline at end of file',
    'diff --git a/other.txt b/other.txt',
    added([github], 'other.txt'),
  ].join('\n').replaceAll('\n', '\r\n')
  assert.deepEqual(scanDiff(input).map(({ rule, file, line }) => ({ rule, file, line })), [
    { rule: 'email', file: 'new name.txt', line: 51 },
    { rule: 'npm-token', file: 'new name.txt', line: 90 },
    { rule: 'github-token', file: 'other.txt', line: 1 },
  ])
})

test('reads the destination path from a Git-quoted header', () => {
  const diff = ['--- "a/caf\\303\\251.txt"', '+++ "b/caf\\303\\251.txt"', '@@ -1 +1 @@', '-old', `+${github}`].join('\n')
  assert.equal(scanDiff(diff)[0]?.file, 'café.txt')
})

test('never repeats a matched credential from inside the destination filename', () => {
  const findings = scanDiff(added([privateKey, 'password' + '=' + sample], `${sample}.txt`))
  assert.equal(findings.length, 2)
  assert.equal(JSON.stringify(findings).includes(sample), false)
})

test('allows GitHub noreply addresses by default but not other addresses', () => {
  const similar = githubNoreply + '.example.test'
  const findings = scanDiff(added([githubNoreply, orgNoreply, similar]))
  assert.deepEqual(findings.map(({ line }) => line), [2, 3])
})

test('the email allowlist accepts whole addresses and regexes and replaces the default', () => {
  const pattern = /@automation\.example\.test$/g
  const diff = added([
    orgNoreply.toUpperCase(),
    'fixture-one' + '@' + 'automation.example.test',
    'fixture-two' + '@' + 'automation.example.test',
    'other-' + orgNoreply,
    githubNoreply,
  ])
  assert.deepEqual(scanDiff(diff, { emailAllowlist: [orgNoreply, pattern] }).map(({ line }) => line), [4, 5])
})

test('adds a custom rule without disabling defaults', () => {
  const code = 'ORG_' + 'FIXTURE42'
  const pattern = /ORG_[A-Z0-9]+/g
  const diff = added([`${code} ${code}`, person, code])
  const findings = scanDiff(diff, { patterns: { 'org-code': pattern } })
  assert.deepEqual(findings.map(({ rule, line }) => ({ rule, line })), [
    { rule: 'org-code', line: 1 },
    { rule: 'org-code', line: 1 },
    { rule: 'email', line: 2 },
    { rule: 'org-code', line: 3 },
  ])
  assert.equal(JSON.stringify(findings).includes(code), false)
})

test('replaces a rule instead of scanning with both versions', () => {
  const findings = scanDiff(added([github, 'INTERNAL-' + 'FIXTURE']), { patterns: { 'github-token': /INTERNAL-[A-Z]+/ } })
  assert.deepEqual(findings.map(({ rule, line }) => ({ rule, line })), [{ rule: 'github-token', line: 2 }])
})

test('disables an individual rule', () => {
  const findings = scanDiff(added([github, npm]), { patterns: { 'github-token': false } })
  assert.deepEqual(findings.map(({ rule }) => rule), ['npm-token'])
})

test('preflight refuses with redacted findings and honors scanner options', () => {
  const diff = added([person])
  assert.deepEqual(preflight(diff), {
    status: 'refuse',
    findings: [{ rule: 'email', file: 'config.txt', line: 1, match: '[redacted]' }],
  })
  assert.equal(preflight(diff, { emailAllowlist: [person] }).status, 'allow')
})
