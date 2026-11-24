// Linux CI runs these tests. On macOS they are skipped with a one-line reason.
export function macSkip(reason: string): string | false {
  return process.platform === 'darwin' ? reason : false
}
