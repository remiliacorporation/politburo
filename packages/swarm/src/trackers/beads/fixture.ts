import type { BdRunner } from './types.ts'

export function fixtureRunner(fixture: unknown): BdRunner {
  const invalid = () => new Error('invalid bd fixture')
  if (typeof fixture !== 'object' || fixture === null || Array.isArray(fixture) ||
    !('bdVersion' in fixture) || typeof fixture.bdVersion !== 'string' ||
    !('calls' in fixture) || !Array.isArray(fixture.calls)) throw invalid()

  const calls = new Map<string, string>()
  for (const call of fixture.calls as unknown[]) {
    if (typeof call !== 'object' || call === null || Array.isArray(call) ||
      !('argv' in call) || !Array.isArray(call.argv) || [...call.argv].some((arg) => typeof arg !== 'string') ||
      !('stdout' in call) || typeof call.stdout !== 'string') throw invalid()
    const key = JSON.stringify(call.argv)
    if (!calls.has(key)) calls.set(key, call.stdout)
  }
  return async (argv) => {
    const stdout = calls.get(JSON.stringify(argv))
    if (stdout === undefined) throw new Error('unrecorded call')
    return stdout
  }
}
