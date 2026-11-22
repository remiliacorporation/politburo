import { scanDiff, type PrivacyOptions } from '@remilia/politburo-runtime'
import { GitError, gitAt, type Exec } from './exec.ts'

export async function diffFindings(git: ReturnType<typeof gitAt>, base: string, head: string, opts?: PrivacyOptions) {
  if (!base || base.includes('..')) throw new GitError('invalid base ref')
  const diff = await git('log', '-p', '-m', '--diff-merges=separate', '--format=', '--unified=0', '--inter-hunk-context=0',
    '--text', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/',
    '--end-of-options', `${base}..${head}`, '--')
  return scanDiff(diff, opts).map((finding) => finding.file.split('\n').some((line) =>
    scanDiff(`--- /dev/null\n+++ b/path\n@@ -0,0 +1 @@\n+${line}\n`, opts).length)
    ? { ...finding, file: '[redacted]' } : finding)
}

export function preflightCommand({ repo, base, exec }: { repo: string; base: string; exec?: Exec }) {
  return diffFindings(gitAt(repo, exec), base, 'HEAD')
}
