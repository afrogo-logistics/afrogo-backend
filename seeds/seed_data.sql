-- Seed data for AfroGo headless UAT (Postgres / Aurora)
-- Run this against your dev Aurora cluster when setting up a new environment.
-- The statements here are idempotent (useful for repeated runs).

-- Zones
CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT
);

INSERT INTO zones (id, name, description)
VALUES
  ('SOWETO_SOUTH', 'Soweto South', 'Test zone for War Games'),
  ('SOWETO_EAST', 'Soweto East', 'Test zone')
ON CONFLICT (id) DO NOTHING;

-- Rate cards (Model C)
CREATE TABLE IF NOT EXISTS rate_cards (
  id TEXT PRIMARY KEY,
  zone_id TEXT REFERENCES zones(id),
  base_fee NUMERIC NOT NULL DEFAULT 30,
  per_km NUMERIC NOT NULL DEFAULT 0.125,
  currency TEXT NOT NULL DEFAULT 'ZAR'
);

INSERT INTO rate_cards (id, zone_id, base_fee, per_km, currency)
VALUES
  ('modelc_soweto', 'SOWETO_SOUTH', 30, 0.125, 'ZAR'),
  ('modelc_soweto_east', 'SOWETO_EAST', 30, 0.125, 'ZAR')
ON CONFLICT (id) DO NOTHING;

-- Sample merchant
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_email TEXT,
  metadata JSONB DEFAULT '{}'
);

INSERT INTO merchants (id,name,contact_email,metadata)
VALUES
  ('MERCHANT_UAT_1','TestMerchant - Soweto','ops+merchant1@afrogo.co.za','{"onboardingSource":"internal_uat"}')
ON CONFLICT (id) DO NOTHING;

-- Sample driver
CREATE TABLE IF NOT EXISTS drivers (
  id TEXT PRIMARY KEY,
  name TEXT,
  phone TEXT
);

INSERT INTO drivers (id,name,phone)
VALUES
  ('DRIVER_UAT_1','UAT Driver','+27830000001')
ON CONFLICT (id) DO NOTHING;

-- Payout topups table (idempotency key unique)
CREATE TABLE IF NOT EXISTS payout_topups (
  id UUID PRIMARY KEY,
  payout_id TEXT NOT NULL,
  topup_amount NUMERIC NOT NULL,
  idempotency_key TEXT UNIQUE,
  note TEXT,
  approver TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);