# Merchant Ledger / Payment Events Migration

This document contains SQL and guidance to create the event and ledger tables
used by the Billing service for enterprise-grade idempotency and auditability.

Apply these migrations in a safe window; test in staging before production.

Files in `services/billing-service/migrations/`:

- `001-create-merchant-payment-events.sql` — append-only event table with idempotency index
- `002-create-merchant-ledger.sql` — invoice-level projection with unique invoice constraint

Recommended follow-up:

1. Apply migrations during a maintenance window.
2. Ensure application `PG_SECRET_ARN` has adequate permissions.
3. Deploy application code that first inserts into `merchant_payment_events` then upserts `merchant_ledger`.
4. Monitor error rates and check for constraint violations (should be none if idempotency keys are correct).
