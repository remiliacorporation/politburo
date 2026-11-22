import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { type Clock, CutoverError, hasOnly } from './ports.ts'

export interface Gate { file: string; sha256: string; by: string; at: string }

export async function verifyGate(tag: string, file: string | undefined, clock: Clock, maxAgeDays = 14): Promise<Gate> {
  if (!file) throw new CutoverError('gate_missing', 'a gate decision file is required (--gate)')
  const invalid = (why: string) => new CutoverError('gate_invalid', `gate decision ${why}`)
  let bytes: Buffer
  try { bytes = await readFile(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CutoverError('gate_missing', 'gate file not found')
    throw invalid('file cannot be read')
  }
  let gate: unknown
  try { gate = JSON.parse(bytes.toString('utf8')) } catch { throw invalid('is not valid JSON') }
  if (!hasOnly(gate, 'tag decision by at evidence')) throw invalid('has an invalid shape or unknown fields')
  if (gate.tag !== tag) throw invalid('is for the wrong tag')
  if (gate.decision !== 'proceed') throw invalid('must be proceed')
  if (typeof gate.by !== 'string' || !gate.by.trim()) throw invalid('requires a non-empty by')
  if (typeof gate.evidence !== 'string') throw invalid('requires evidence text')
  if (typeof gate.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(gate.at) || !Number.isFinite(Date.parse(gate.at))) {
    throw invalid('requires an ISO date-time in at')
  }
  const age = clock.now() - Date.parse(gate.at)
  if (age < 0) throw invalid('is dated in the future')
  if (age > maxAgeDays * 86_400_000) throw invalid('is too old')
  return { file, sha256: createHash('sha256').update(bytes).digest('hex'), by: gate.by, at: gate.at }
}
