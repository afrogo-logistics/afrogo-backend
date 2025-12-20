-- 004-add-ledger-last-event-seq.sql
-- Add last_event_seq to merchant_ledger to persist the last applied event's sequence
-- and use it as the deterministic tie-break when event_time values are identical.
BEGIN;

ALTER TABLE merchant_ledger
  ADD COLUMN IF NOT EXISTS last_event_seq BIGINT NULL;

CREATE INDEX IF NOT EXISTS merchant_ledger_last_event_seq_idx
  ON merchant_ledger (last_event_seq);

COMMIT;
