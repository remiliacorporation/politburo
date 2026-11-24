export type LedgerErrorCode =
  | 'invalid' // input failed validation; `message` says which field
  | 'locked' // another process holds the ledger file: one writer
  | 'version' // the file's schema version is not this code's
  | 'dispatch_conflict' // an execution id already has a different dispatch
  | 'unknown_dispatch' // a referenced dispatch was never persisted
  | 'cross_party_link' // a dispatch names a parent or sponsor in another party
  | 'envelope_mismatch' // a record's envelope is not the stored dispatch's envelope
  | 'unknown_revision' // `revises` names no record
  | 'already_revised' // the revised record is not the head of its chain
  | 'moves_charge' // a correction names a different dispatch than the record it revises
  | 'record_id_taken' // record_id exists under a different dedupe_key
  | 'intent_exists' // intent_id has different content or the execution already has an intent
  | 'unknown_intent'
  | 'stale_fence' // the supplied fence does not match the intent's
  | 'intent_closed' // the intent is launched or compensated
  | 'intent_ambiguous' // reconcile the intent before acting on it
  | 'not_ready' // the intent has not reached the required launch state
  | 'not_bindable' // only an unbound (unattributed) head can be bound

/** The one error type of the ledger. Branch on `code`. */
export class LedgerError extends Error {
  readonly code: LedgerErrorCode
  constructor(code: LedgerErrorCode, message: string) {
    super(message)
    this.name = 'LedgerError'
    this.code = code
  }
}
