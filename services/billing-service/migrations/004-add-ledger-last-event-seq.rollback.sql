-- rollback for 004-add-ledger-last-event-seq.sql
BEGIN;

ALTER TABLE IF EXISTS merchant_ledger DROP COLUMN IF EXISTS last_event_seq;

DROP INDEX IF EXISTS merchant_ledger_last_event_seq_idx;

COMMIT;
