-- ROLLBACK 001-create-merchant-payment-events.sql
BEGIN;

DROP INDEX IF EXISTS merchant_payment_events_received_at_idx;
DROP INDEX IF EXISTS merchant_payment_events_merchant_idx;
DROP INDEX IF EXISTS merchant_payment_events_invoice_idx;
DROP INDEX IF EXISTS merchant_payment_events_uq;

DROP TABLE IF EXISTS merchant_payment_events;

COMMIT;
