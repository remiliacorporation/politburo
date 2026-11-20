export type HarnessKind = 'pi' | 'codex-cli' | 'claude-cloud' | 'subprocess'

/** Immutable inputs for one attempt. The fixture adapters enforce wall time, not repo, path, cost, or check policy. */
export type WorkSpec = Readonly<{
  repo: string
  baseSha: string
  briefRef: string
  briefSha256: string
  allowedPaths: readonly string[]
  limits: Readonly<{ wallMs: number; maxCostMicros: number }>
  requiredCheckIds: readonly string[]
}>

export type Start = Readonly<{
  attemptId: string
  taskId: string
  claimEpoch: number
  work: WorkSpec
  provider: string
  model?: string
}>

/** An opaque adapter handle, not a credential. */
export type RunRef = string
export type State = 'starting' | 'running' | 'stopping' | 'exited' | 'failed' | 'canceled'
export type Failure = 'transient' | 'quota' | 'provider_access' | 'timeout' | 'verification' | 'lost'
export type Usage = Readonly<{ costMicros: number }>
export type RunEvent = Readonly<{ type: 'stdout' | 'stderr'; text: string }>

export type Observation = Readonly<{
  state: State
  /** Opaque continuation for this run. Pass it as `after`; don't parse or sort it. */
  cursor: string
  events: readonly RunEvent[]
  usage: Usage | null
}>

export type Result = Readonly<{
  outcome: 'exited' | 'failed' | 'canceled'
  exitCode?: number
  failure?: Failure
  headSha?: string
  artifacts: readonly Readonly<{ ref: string; sha256: string }>[]
  usage: Usage | null
}>

export type Send = Readonly<{ id: string; text: string }>
export type SendOutcome = 'accepted' | 'unsupported' | 'not_running'

/** The same ID was used with a different payload in the adapter's replay scope. */
export class ReplayConflict extends Error {
  override name = 'ReplayConflict'
}

export interface Harness {
  /** Start once per attempt ID; identical replays return the same ref. Reconcile an uncertain start before retrying. */
  start(input: Start): Promise<RunRef>
  /** Read at most `limit` events in append order. An observation error is not an exit. */
  observe(run: RunRef, options: { after?: string; limit: number }): Promise<Observation>
  /** Replay the first answer for a send ID scoped to this run. Different text conflicts, even after exit. */
  send(run: RunRef, input: Send): Promise<SendOutcome>
  /** Request stop; use observe or collect to confirm it. An already-ended run is unchanged. */
  cancel(run: RunRef): Promise<void>
  /** Return `not_terminal` until the run ends. Terminal state and result never change. */
  collect(run: RunRef): Promise<Result | 'not_terminal'>
}
