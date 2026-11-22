import { scanDiff, type PrivacyFinding, type PrivacyOptions } from '@remilia/politburo-runtime'
import { GitError, gitAt, type Exec } from './exec.ts'

export type CheckFinding = Omit<PrivacyFinding, 'file'> & { file: `file#${number}` }

export async function diffFindings(git: ReturnType<typeof gitAt>, base: string, head: string, opts?: PrivacyOptions): Promise<CheckFinding[]> {
  if (!base || base.includes('..')) throw new GitError('invalid base ref')
  const diff = await git('log', '--root', '-p', '-m', '--diff-merges=separate', '--format=', '--unified=0', '--inter-hunk-context=0',
    '--text', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/',
    '--end-of-options', `${base}..${head}`, '--')
  const files = new Map<string, number>()
  // Keep file identity from the patch header: scanDiff can already redact distinct paths to the same string.
  return diff.split(/^diff --git /m).flatMap((patch) => {
    const path = /^\+\+\+ ([^\t\n]+)/m.exec(patch)?.[1]
    const findings = scanDiff(patch, opts)
    if (!path || !findings.length) return []
    const index = files.get(path) ?? files.size + 1
    files.set(path, index)
    return findings.map((finding) => ({ ...finding, file: `file#${index}` as const }))
  })
}

export function preflightCommand({ repo, base, exec }: { repo: string; base: string; exec?: Exec }) {
  return diffFindings(gitAt(repo, exec), base, 'HEAD')
}
