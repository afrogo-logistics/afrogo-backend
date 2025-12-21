-- rollback for 003-add-event-seq.sql
BEGIN;

ALTER TABLE IF EXISTS merchant_payment_events DROP COLUMN IF EXISTS event_seq;

DROP INDEX IF EXISTS merchant_payment_events_event_seq_idx;

COMMIT;
