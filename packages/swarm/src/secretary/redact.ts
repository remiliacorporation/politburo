export function redact(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*KEY-----|$)/gi, '[redacted]')
    .replace(/\bBearer\s+(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s,;"'<>]+)/gi, 'Bearer [redacted]')
    .replace(/\b(password|token)\s*=\s*(?:Bearer\s+\[redacted\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)?/gi, '$1=[redacted]')
    .replace(/(?:sk-|ghp_|github_pat_|xox[a-z]-)[a-z0-9_-]+|AKIA[A-Z0-9]+/gi, '[redacted]')
}
