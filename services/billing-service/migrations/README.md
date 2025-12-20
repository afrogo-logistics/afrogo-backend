# Billing Service Migrations

This folder contains SQL migrations for the Billing service. Use the provided migration runner to apply or validate migrations.

Files are intended to be idempotent and are applied in alphabetical order. The runner will stop on the first failed migration.

Usage (local):

```powershell
# Install project deps (root)
npm ci

# Run migrations against an environment (example for local Postgres)
set PGHOST=127.0.0.1
set PGPORT=5432
set PGUSER=postgres
set PGPASSWORD=postgres
set PGDATABASE=postgres
node services\billing-service\tools\migrate-runner.cjs

# Dry-run (prints migrations but does not execute)
node services\billing-service\tools\migrate-runner.cjs --dry-run
```

CI validation
-------------
We provide a GitHub Actions workflow that spins up a Postgres service and runs the migration runner to validate the SQL applies cleanly.

Operational notes about making event insert strict
-------------------------------------------------
- The current code intentionally treats the insertion of `merchant_payment_events` as best-effort: if inserting the event fails the webhook continues and the invoice state is still updated. This prevents blocking provider callbacks in transient DB outage scenarios.
- You asked to "make the event insert strict (fail the webhook if event insert fails)" — do NOT change runtime behavior until you have applied the migrations in staging and validated with the WarGames runner. After staging verification, we recommend toggling the behavior behind a feature flag or step-deploy to turn event-insert into a hard-failing operation.

Recommended staged rollout:
1. Apply migrations in staging using the runner.
2. Run WarGames in staging to validate idempotency and retry semantics.
3. If OK, flip webhook behavior to fail on event-insert failures (and run canary traffic).
