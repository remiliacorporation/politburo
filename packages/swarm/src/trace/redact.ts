const SECRET_NAME = /auth|credential|cookie|session|secret|token|password|passwd|(?:^|_)key(?:_|$)/i

function keepBreak(value: string): string {
  return value.endsWith('\r') ? '[redacted]\r' : '[redacted]'
}

/** A header whose value is a credential: Authorization, Cookie, X-Api-Key, and the same kind of name. */
function secretHeader(name: string): boolean {
  const normalized = name.toLowerCase()
  if (normalized.includes('authorization') || normalized.includes('cookie') || /api[-_]?key/.test(normalized)) return true
  return normalized.split('-').some((part) => /^(?:key|token|secret|password|passwd|auth|session|credential)$/.test(part))
}

/** Replaces secrets with `[redacted]` and leaves every other character as it was. */
export function redactTrace(text: string): string {
  const withoutKeys = text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted]')
  const withoutHeaders = withoutKeys.replace(/^([ \t]*)([A-Za-z][A-Za-z0-9-]*)([ \t]*:[ \t]*)(.*)$/gm, (line, indent: string, name: string, sep: string, value: string) => {
    if (!secretHeader(name)) return line
    return `${indent}${name}${sep}${keepBreak(value)}`
  })
  const withoutEnv = withoutHeaders.replace(/^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)(.*)$/gm, (line, lead: string, name: string, eq: string, value: string) => {
    if (!SECRET_NAME.test(name)) return line
    return `${lead}${name}${eq}${keepBreak(value)}`
  })
  const withoutUrls = withoutEnv.replace(/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):([^@\s/]+)@/gi, '$1:[redacted]@')
  let withoutShapes = withoutUrls
  for (const shape of [
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bsk-(?:live|test|proj-)?[A-Za-z0-9_-]{10,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  ]) withoutShapes = withoutShapes.replace(shape, '[redacted]')
  return withoutShapes.replace(/\b(api[ _-]?key|access[ _-]?key|secret|token|password|key)\b(\s*[:=]\s*)(\S+)/gi, (_match, name: string, sep: string, value: string) => {
    if (value === '[redacted]' || value.startsWith('[redacted]')) return `${name}${sep}${value}`
    return `${name}${sep}${keepBreak(value)}`
  })
}
