-- ROLLBACK 002-create-merchant-ledger.sql
BEGIN;

DROP INDEX IF EXISTS merchant_ledger_status_idx;
DROP INDEX IF EXISTS merchant_ledger_merchant_idx;
DROP INDEX IF EXISTS merchant_ledger_invoice_uq;

DROP TABLE IF EXISTS merchant_ledger;

COMMIT;
