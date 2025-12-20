-- 001-create-merchant-payment-events.sql
-- Enterprise-grade event-level table for provider webhooks
BEGIN;

-- Ensure pgcrypto exists for gen_random_uuid(); harmless if already present
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS merchant_payment_events (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Provider identity & idempotency
  provider                TEXT NOT NULL,
  provider_event_id       TEXT NOT NULL,

  -- AfroGo business keys
  invoice_id              TEXT NOT NULL,
  merchant_id             TEXT NULL,

  -- Event semantics
  event_type              TEXT NOT NULL,
  event_time              TIMESTAMPTZ NULL,
  received_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Money (normalized)
  amount_cents            BIGINT NULL,
  currency                CHAR(3) NULL,

  -- Provider status fields
  status                  TEXT NULL,

  -- Forensics
  raw_payload             JSONB NOT NULL
);

-- Idempotency: prevent duplicate events for same provider
CREATE UNIQUE INDEX IF NOT EXISTS merchant_payment_events_uq
  ON merchant_payment_events (provider, provider_event_id);

-- Query helpers
CREATE INDEX IF NOT EXISTS merchant_payment_events_invoice_idx
  ON merchant_payment_events (invoice_id);

CREATE INDEX IF NOT EXISTS merchant_payment_events_merchant_idx
  ON merchant_payment_events (merchant_id);

CREATE INDEX IF NOT EXISTS merchant_payment_events_received_at_idx
  ON merchant_payment_events (received_at DESC);

COMMIT;
