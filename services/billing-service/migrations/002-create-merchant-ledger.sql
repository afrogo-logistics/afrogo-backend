-- 002-create-merchant-ledger.sql
-- Enterprise-grade invoice-level ledger (read model)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS merchant_ledger (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- One row per invoice
  invoice_id              TEXT NOT NULL,
  merchant_id             TEXT NULL,

  -- Money (always cents)
  invoice_total_cents     BIGINT NOT NULL DEFAULT 0,
  paid_total_cents        BIGINT NOT NULL DEFAULT 0,
  currency                CHAR(3) NOT NULL DEFAULT 'ZAR',

  -- State machine
  payment_status          TEXT NOT NULL DEFAULT 'UNPAID',
  -- Suggested statuses: UNPAID | PARTIALLY_PAID | PAID | FAILED | REFUNDED | CHARGEBACK

  -- Last provider footprint (for support + reconciliation)
  last_provider           TEXT NULL,
  last_provider_ref       TEXT NULL,
  last_provider_event_id  TEXT NULL,
  last_event_db_id        UUID NULL,
  last_event_time         TIMESTAMPTZ NULL,

  paid_at                 TIMESTAMPTZ NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enforce invoice-level idempotency
CREATE UNIQUE INDEX IF NOT EXISTS merchant_ledger_invoice_uq
  ON merchant_ledger (invoice_id);

-- Optional: if you have merchant dashboards
CREATE INDEX IF NOT EXISTS merchant_ledger_merchant_idx
  ON merchant_ledger (merchant_id);

-- For operations queries
CREATE INDEX IF NOT EXISTS merchant_ledger_status_idx
  ON merchant_ledger (payment_status);

COMMIT;
