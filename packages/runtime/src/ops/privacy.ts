export type PrivacyOptions = {
  /**
   * Add or replace a rule by name, or set it to false to disable it. Rules match within one added line.
   * Built-ins: github-token, npm-token, slack-token, aws-access-key, private-key, secret-assignment, email.
   */
  patterns?: Readonly<Record<string, RegExp | false>>
  /** Replaces the GitHub noreply defaults. Strings match whole addresses, case-insensitively. */
  emailAllowlist?: readonly (string | RegExp)[]
}

export type PrivacyFinding = {
  rule: string
  /** Destination path, redacted if it repeats a value detected in that file. */
  file: string
  /** One-based line number in the new file. */
  line: number
  match: '[redacted]'
}

export type PreflightResult =
  | { status: 'allow' }
  | { status: 'refuse'; findings: PrivacyFinding[] }

const assignment = /(?<![\w-])(?:[\w-]+[_-])?(?:api[_-]?key|secret(?:[_-]access[_-]key)?|password)["']?\s*(?:=(?!=)|:)\s*("(?:\\.|[^"\\])+"|'(?:\\.|[^'\\])+'|`(?:\\.|[^`\\])+`|[^\s,;"'`$<>{}\[\]()=]+)/i
const defaults = {
  'github-token': /\b(?:gh[pousr]_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59})\b/,
  'npm-token': /\bnpm_[a-zA-Z0-9]{36}\b/,
  'slack-token': /\b(?:xox[abprs]|xapp)-[a-zA-Z0-9-]{10,}\b/,
  'aws-access-key': /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  'private-key': /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/,
  'secret-assignment': assignment,
  email: /(?<![a-z0-9.!#$%&*+?^_`{|}~=-])[a-z0-9.!#$%&*+?^_`{|}~=-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?![a-z0-9-])/i,
}
const noreply = [/^[^@]+@users\.noreply\.github\.com$/i, /^noreply@github\.com$/i]
const redacted = '[redacted]' as const

function headerPath(header: string): string {
  const path = header.slice(4).split('\t', 1)[0] ?? ''
  if (!path.startsWith('"') || !path.endsWith('"')) return path
  // Git quotes unusual paths and writes non-ASCII UTF-8 bytes as octal escapes.
  const escapes: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r' }
  return path.slice(1, -1).replace(/(?:\\[0-7]{3})+|\\(.)/g, (escaped: string, char?: string) => {
    if (char !== undefined) return escapes[char] ?? char
    const bytes = escaped.split('\\').slice(1).map((octal) => parseInt(octal, 8))
    return Buffer.from(bytes).toString('utf8')
  })
}

function* additions(diff: string) {
  let file = ''
  let oldPath = ''
  let line = 0
  let oldLeft = 0
  let newLeft = 0
  for (const row of diff.split(/\r?\n/)) {
    if (oldLeft > 0 || newLeft > 0) {
      const prefix = row[0]
      if (prefix === '\\') continue // No-newline marker belongs to neither file.
      if (prefix === '+' && newLeft > 0) {
        if (file && file !== '/dev/null') yield { file, line, text: row.slice(1) }
        line++
        newLeft--
        continue
      }
      if (prefix === '-' && oldLeft > 0) { oldLeft--; continue }
      if (prefix === ' ' && oldLeft > 0 && newLeft > 0) { oldLeft--; newLeft--; line++; continue }
      oldLeft = newLeft = 0
    }
    if (row.startsWith('diff ')) {
      file = oldPath = ''
    } else if (row.startsWith('--- ')) {
      oldPath = headerPath(row)
      file = ''
    } else if (row.startsWith('+++ ')) {
      file = headerPath(row)
      if (file.startsWith('b/') && (oldPath.startsWith('a/') || oldPath === '/dev/null')) file = file.slice(2)
    } else {
      const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row)
      if (hunk) {
        oldLeft = Number(hunk[1] ?? 1)
        line = Number(hunk[2])
        newLeft = Number(hunk[3] ?? 1)
      }
    }
  }
}

/** Heuristically scan added lines of a unified diff. Private keys are flagged at their opening marker. */
export function scanDiff(diff: string, { patterns, emailAllowlist = noreply }: PrivacyOptions = {}): PrivacyFinding[] {
  const configured: NonNullable<PrivacyOptions['patterns']> = { ...defaults, ...patterns }
  const rules = Object.entries(configured).flatMap(([name, pattern]) =>
    pattern === false ? [] : [{ name, regex: new RegExp(pattern.source, pattern.global ? pattern.flags : `${pattern.flags}g`), pattern }],
  )
  const allowed = emailAllowlist.map((entry) => typeof entry === 'string' ? entry.toLowerCase() : entry)
  const findings: PrivacyFinding[] = []
  const sensitivePaths = new Set<string>()
  for (const { file, line, text } of additions(diff)) {
    for (const { name, pattern, regex } of rules) {
      for (const hit of text.matchAll(regex)) {
        const matched = hit[0]
        if (!matched || (name === 'email' && allowed.some((entry) =>
          typeof entry === 'string' ? entry === matched.toLowerCase() : matched.search(entry) !== -1,
        ))) continue
        // A matched value can also be present in the destination filename.
        const value = (pattern === assignment ? hit[1]?.replace(/^["'`]|["'`]$/g, '') : matched) ?? matched
        if (value && file.includes(value)) sensitivePaths.add(file)
        findings.push({ rule: name, file, line, match: redacted })
      }
    }
  }
  for (const finding of findings) {
    if (sensitivePaths.has(finding.file)) finding.file = redacted
  }
  return findings
}

/** Refuse a diff with any finding. The refusal contains only redacted findings. */
export function preflight(diff: string, opts?: PrivacyOptions): PreflightResult {
  const findings = scanDiff(diff, opts)
  return findings.length ? { status: 'refuse', findings } : { status: 'allow' }
}
