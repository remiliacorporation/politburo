import { createHash } from 'node:crypto'

const marker = '<!-- politburo-outcomes:v1 -->'
const maxDescriptionLength = 20_000
const sectionHeading = /^ {0,3}#{1,2}(?:[ \t]|$)/
const reservedHeading = /^ {0,3}##[ \t]+(?:Acceptable outcomes|Verification)(?:[ \t]+#+)?[ \t]*$/
const controlCharacter = /\p{Cc}/u

type Artifact = { location: string; required_sections: string[]; evidence: 'path' }

export type Outcome =
  | {
    kind: 'pull_request'
    repo: string
    base: string
    state: 'open_or_merged' | 'merged'
    checks: 'required_pass' | 'none'
    evidence: 'url'
    draft: 'allowed' | 'not_allowed'
  }
  | ({ kind: 'report' } & Artifact)
  | ({ kind: 'research' } & Artifact)
  | { kind: 'ops'; receipt: string; verification: string; evidence: 'url' | 'path' }

export type OutcomesContract = {
  outcomes: Outcome[]
  completionRule: 'any_outcome' | 'all_outcomes'
  reviewer: string | null
  onNoMatch: 'release_and_dock'
}

function fenceRun(line: string) {
  let start = 0
  while (start < 3 && line[start] === ' ') start++
  const char = line[start]
  if (char !== '`' && char !== '~') return
  let end = start + 1
  while (line[end] === char) end++
  const width = end - start
  if (width >= 3) return { char, width, rest: line.slice(end) }
}

function insideFence(lines: readonly string[]): boolean {
  let fence: ReturnType<typeof fenceRun>
  for (const line of lines) {
    const run = fenceRun(line)
    if (!run) continue
    if (!fence) {
      if (run.char === '~' || !run.rest.includes('`')) fence = run
    } else if (run.char === fence.char && run.width >= fence.width && /^[ \t]*$/.test(run.rest)) {
      fence = undefined
    }
  }
  return fence !== undefined
}

function contractBlock(description: string) {
  const offset = description.indexOf(marker)
  if (offset === -1 || offset !== description.lastIndexOf(marker)) {
    return 'The outcomes marker must appear exactly once.'
  }
  // Keep line endings for the fingerprint; Markdown recognizes LF, CRLF, and bare CR.
  const raw = description.split(/(?<=\n)|(?<=\r)(?!\n)/)
  const lines = raw.map(line => line.replace(/(?:\r\n|\r|\n)$/, ''))
  const start = lines.findIndex(line => line.startsWith(marker) && /^[ \t]*$/.test(line.slice(marker.length)))
  let heading = start - 1
  while (heading >= 0 && !lines[heading]!.trim()) heading--
  if (heading < 0 || !/^## Acceptable outcomes[ \t]*$/.test(lines[heading]!)) {
    return 'Place the outcomes marker under the Acceptable outcomes heading.'
  }
  const verification = lines.findIndex((line, i) => i > start && sectionHeading.test(line))
  if (verification === -1 || !/^## Verification[ \t]*$/.test(lines[verification]!)) {
    return 'The Verification section must immediately follow the outcome list.'
  }
  if (lines.some((line, i) => i !== heading && i !== verification && reservedHeading.test(line))) {
    return 'The Acceptable outcomes and Verification headings must each appear exactly once.'
  }
  let end = lines.findIndex((line, i) => i > verification && sectionHeading.test(line))
  if (end === -1) end = lines.length
  while (end > verification + 1 && !lines[end - 1]!.trim()) end--
  const throughVerification = raw.slice(0, end).join('')
  const outsideMarker = throughVerification.replace(marker, '')
  if (insideFence(lines.slice(0, heading)) || lines.slice(heading, end).some(fenceRun) ||
    /<[A-Za-z/]|<!--/.test(outsideMarker)) {
    return 'The outcomes contract must be outside code blocks and raw HTML.'
  }
  return {
    outcomes: lines.slice(start + 1, verification),
    verification: lines.slice(verification + 1, end),
    text: raw.slice(start, end).join('').replace(/(?:\r\n|\r|\n)$/, ''),
  }
}

type Fields = Map<string, string>

function readField(fields: Fields, text: string): boolean {
  const match = /^([a-z_]+):[ \t]*/.exec(text)
  if (!match) return false
  const key = match[1]!
  const rawValue = text.slice(match[0].length)
  if (/[\u2028\u2029]/.test(rawValue) ||
    ((key === 'base' || key === 'repo' || key === 'location') && controlCharacter.test(rawValue))) return false
  const value = rawValue.trim()
  if (!value || fields.has(key)) return false
  fields.set(key, value)
  return true
}

function onlyFields(fields: Fields, ...allowed: string[]): boolean {
  return [...fields.keys()].every(key => allowed.includes(key))
}

function plausibleBranch(base: string): boolean {
  return !/[\s\p{Cc}~^:?*\[\\]/u.test(base) && !base.includes('..') && !base.includes('@{') &&
    base !== '@' && base !== 'HEAD' && !base.startsWith('-') && !base.endsWith('.') &&
    base.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock'))
}

function readOutcome(fields: Fields): Outcome | string {
  const kind = fields.get('kind')
  const evidence = fields.get('evidence')
  switch (kind) {
    case 'pull_request': {
      if (!onlyFields(fields, 'kind', 'repo', 'base', 'state', 'checks', 'evidence', 'draft')) {
        return 'Unknown pull_request field.'
      }
      const repo = fields.get('repo')
      const base = fields.get('base')
      const state = fields.get('state')
      const checks = fields.get('checks')
      const draft = fields.get('draft') ?? 'not_allowed'
      if (!repo || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo) || repo.split('/').some(part => part === '.' || part === '..') ||
        !base || !plausibleBranch(base)) {
        return 'A pull_request needs an owner/repo and a valid base branch.'
      }
      if ((state !== 'open_or_merged' && state !== 'merged') ||
        (checks !== 'required_pass' && checks !== 'none') || evidence !== 'url' ||
        (draft !== 'allowed' && draft !== 'not_allowed')) {
        return 'Invalid pull_request state, checks, evidence, or draft policy.'
      }
      return { kind, repo, base, state, checks, evidence, draft }
    }
    case 'report':
    case 'research': {
      if (!onlyFields(fields, 'kind', 'location', 'required_sections', 'evidence')) return `Unknown ${kind} field.`
      const location = fields.get('location')
      const sections = /^\[([^\[\]]*)\]$/.exec(fields.get('required_sections') ?? '')?.[1]
      const required_sections = sections?.split(',').map(section => section.trim())
      if (!location || /^(\/|[a-z][a-z0-9+.-]*:)/i.test(location) ||
        location.includes('\\') || location.split('/').includes('..')) {
        return `A ${kind} needs a relative location without parent segments.`
      }
      if (!required_sections?.every(Boolean) || evidence !== 'path') {
        return `A ${kind} needs required sections and path evidence.`
      }
      return { kind, location, required_sections, evidence }
    }
    case 'ops': {
      if (!onlyFields(fields, 'kind', 'receipt', 'verification', 'evidence')) return 'Unknown ops field.'
      const receipt = fields.get('receipt')
      const verification = fields.get('verification')
      if (!receipt || !verification || (evidence !== 'url' && evidence !== 'path')) {
        return 'An ops outcome needs a receipt, verification, and url or path evidence.'
      }
      return { kind, receipt, verification, evidence }
    }
    default: return 'An outcome is missing a known kind.'
  }
}

type InvalidContract = { valid: false; problems: string[] }

function invalid(problem: string): InvalidContract {
  return { valid: false, problems: [problem] }
}

export function parseOutcomesContract(description: string): { valid: true; contract: OutcomesContract } | InvalidContract {
  if (typeof description !== 'string' || description.length > maxDescriptionLength) {
    return invalid('The description must be text of at most 20,000 characters.')
  }
  const block = contractBlock(description)
  if (typeof block === 'string') return invalid(block)

  const items: Fields[] = []
  for (const line of block.outcomes) {
    if (!line.trim()) continue
    if (line.startsWith('- [ ] ')) {
      if (items.length === 20) return invalid('List at most 20 outcomes.')
      const fields: Fields = new Map()
      const first = line.slice('- [ ] '.length)
      if (!first.startsWith('kind:') || !readField(fields, first)) {
        return invalid('Each outcome must start with a kind.')
      }
      items.push(fields)
    } else {
      const current = items.at(-1)
      if (!current || !/^[ \t]/.test(line) || !readField(current, line.trimStart())) {
        return invalid('Malformed, empty, or duplicate outcome field.')
      }
    }
  }
  if (!items.length) return invalid('List at least one outcome.')
  const outcomes: Outcome[] = []
  for (const [index, item] of items.entries()) {
    const outcome = readOutcome(item)
    if (typeof outcome === 'string') return invalid(`Outcome ${index + 1}: ${outcome}`)
    outcomes.push(outcome)
  }

  const verification: Fields = new Map()
  for (const line of block.verification) {
    if (!line.trim()) continue
    if (!line.startsWith('- ') || !readField(verification, line.slice(2))) {
      return invalid('Malformed, empty, or duplicate Verification field.')
    }
  }
  if (!onlyFields(verification, 'completion_rule', 'reviewer', 'on_no_match')) {
    return invalid('Unknown Verification field.')
  }
  const completionRule = verification.get('completion_rule')
  const reviewer = verification.get('reviewer') ?? null
  const onNoMatch = verification.get('on_no_match')
  if (completionRule !== 'any_outcome' && completionRule !== 'all_outcomes') {
    return invalid('Verification needs an any_outcome or all_outcomes completion rule.')
  }
  if (onNoMatch !== 'release_and_dock') return invalid('Verification must release and dock on no match.')
  if (!reviewer && outcomes.some(outcome => outcome.kind !== 'pull_request')) {
    return invalid('Non-PR outcomes need a named reviewer or jockey.')
  }
  return { valid: true, contract: { outcomes, completionRule, reviewer, onNoMatch } }
}

export function contractFingerprint(description: string): string | null {
  if (typeof description !== 'string' || description.length > maxDescriptionLength) return null
  const block = contractBlock(description)
  if (typeof block === 'string') return null
  // Hash the original text, not the parsed fields.
  return createHash('sha256').update(block.text).digest('hex')
}
