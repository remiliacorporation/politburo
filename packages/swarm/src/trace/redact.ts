const SECRET_NAME = /(?:token|secret|password|passwd|credential|auth)(?:_|$)|(?:^|_)key(?:_|$)/i

function keepBreak(value: string): string {
  return value.endsWith('\r') ? '[redacted]\r' : '[redacted]'
}

/** Replaces secrets with `[redacted]` and leaves every other character as it was. */
export function redactTrace(text: string): string {
  const withoutKeys = text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted]')
  const withoutHeaders = withoutKeys.replace(/^(authorization\s*:\s*)(.*)$/gim, (_line, prefix: string) => `${prefix}[redacted]`)
  const withoutEnv = withoutHeaders.replace(/^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)(.*)$/gm, (line, lead: string, name: string, eq: string, value: string) => {
    if (!SECRET_NAME.test(name)) return line
    return `${lead}${name}${eq}${keepBreak(value)}`
  })
  let withoutShapes = withoutEnv
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
