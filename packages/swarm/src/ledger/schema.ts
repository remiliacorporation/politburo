// The ledger's tables. Append-only is enforced here, in the database: every table
// refuses UPDATE and DELETE. Duplicate identity inserts are blocked before
// conflict resolution, since REPLACE need not fire a delete trigger.

const sealed = (table: string) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;`

const noReplace = (table: string, ...keys: string[]) => `
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table}
WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${keys.map((key) => `${key} = NEW.${key}`).join(' OR ')})
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;`

export const SCHEMA_VERSION = 2

export const schema = `
CREATE TABLE dispatches (
  execution_id TEXT PRIMARY KEY,
  party TEXT NOT NULL,
  repo TEXT,
  work_id TEXT,
  attempt TEXT,
  tier TEXT NOT NULL CHECK (tier IN ('core','spawner','secretary','mob','sprite','jockey')),
  parent TEXT,
  session TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  sponsor TEXT,
  created TEXT NOT NULL
) STRICT;
${sealed('dispatches')}
${noReplace('dispatches', 'execution_id')}

CREATE TABLE intents (
  intent_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE REFERENCES dispatches(execution_id),
  board_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  claim_epoch INTEGER NOT NULL CHECK (claim_epoch >= 0),
  fence TEXT NOT NULL,
  reservation_ref TEXT,
  created TEXT NOT NULL
) STRICT;
${sealed('intents')}
${noReplace('intents', 'intent_id', 'execution_id')}

CREATE TABLE intent_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id TEXT NOT NULL REFERENCES intents(intent_id),
  event TEXT NOT NULL CHECK (event IN ('reservation_confirmed','claim_confirmed','launch_started','ambiguous','reconciled_launched','reconciled_not_launched','launched','compensated')),
  at TEXT NOT NULL,
  detail TEXT
) STRICT;
${sealed('intent_events')}
${noReplace('intent_events', 'seq')}

CREATE TABLE records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL UNIQUE,
  dedupe_key TEXT NOT NULL UNIQUE,
  revises TEXT UNIQUE REFERENCES records(record_id),
  actor TEXT,
  reason TEXT,
  execution_id TEXT REFERENCES dispatches(execution_id),
  source TEXT NOT NULL,
  source_version TEXT NOT NULL,
  source_event_key TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  provider TEXT,
  requested_route TEXT,
  actual_model TEXT,
  auth_class TEXT,
  input_uncached INTEGER CHECK (input_uncached >= 0),
  input_total INTEGER CHECK (input_total >= 0),
  output INTEGER CHECK (output >= 0),
  cache_read INTEGER CHECK (cache_read >= 0),
  cache_write INTEGER CHECK (cache_write >= 0),
  reasoning INTEGER CHECK (reasoning >= 0),
  amount_value TEXT,
  amount_unit TEXT,
  basis TEXT NOT NULL CHECK (basis IN ('priced_estimate','settled_charge','measured_resource','unknown','not_applicable')),
  occurred TEXT,
  received TEXT NOT NULL,
  started TEXT,
  ended TEXT,
  status TEXT NOT NULL,
  exit_reason TEXT,
  coverage_state TEXT NOT NULL CHECK (coverage_state IN ('live','pending','partial','unattributed','conflict','closed_reconciled')),
  field_quality TEXT NOT NULL,
  -- An unbound observation is unattributed, and only it.
  CHECK ((execution_id IS NULL) = (coverage_state = 'unattributed')),
  -- A correction names who and why.
  CHECK (revises IS NULL OR (actor IS NOT NULL AND reason IS NOT NULL AND length(reason) > 0)),
  CHECK (revises IS NULL OR revises <> record_id),
  -- An amount is both parts or neither, and only a priced or measured basis has one.
  CHECK ((amount_value IS NULL) = (amount_unit IS NULL)),
  CHECK ((basis IN ('priced_estimate','settled_charge','measured_resource')) = (amount_value IS NOT NULL))
) STRICT;
CREATE INDEX records_execution ON records(execution_id);
${sealed('records')}
${noReplace('records', 'seq', 'record_id', 'dedupe_key', 'revises')}

-- A correction keeps the charge where it was booked: it may bind an unbound
-- observation, and otherwise stays on the same dispatch. Reassignment moves nothing.
CREATE TRIGGER records_revision_keeps_dispatch BEFORE INSERT ON records
WHEN NEW.revises IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a correction cannot move a charge to another dispatch')
  WHERE EXISTS (
    SELECT 1 FROM records p
    WHERE p.record_id = NEW.revises AND p.execution_id IS NOT NULL AND p.execution_id IS NOT NEW.execution_id
  );
END;

-- The current value of each chain: records nothing revises. Totals read this only.
CREATE VIEW heads AS
SELECT r.* FROM records r WHERE NOT EXISTS (SELECT 1 FROM records n WHERE n.revises = r.record_id);
`
