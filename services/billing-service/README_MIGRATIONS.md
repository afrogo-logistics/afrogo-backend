Billing service — migrations and deterministic ledger notes
=========================================================

Summary
-------
This note documents the deterministic ledger ordering and the migrations added to support it.

- We use an append-only event table `merchant_payment_events` for payments/events.
- To make ledger projection deterministic when multiple events share the same timestamp, we introduced a monotonic identity column `event_seq` and store the last applied `last_event_seq` on `merchant_ledger`.

Key migrations
--------------
- `001-create-merchant-payment-events.sql` — original events table.
- `002-create-merchant-ledger.sql` — original ledger projection table.
- `003-add-event-seq.sql` — adds `event_seq BIGINT GENERATED ALWAYS AS IDENTITY` to `merchant_payment_events`.
- `004-add-ledger-last-event-seq.sql` — adds `last_event_seq BIGINT` to `merchant_ledger` and wires it into the upsert logic.

Runtime guarantees
------------------
- Events are inserted immutably using INSERT ... ON CONFLICT DO NOTHING and then selected to obtain the canonical row (and `event_seq`).
- Ledger projection uses a conditional UPSERT that compares `(last_event_time, last_event_seq)` and only applies the EXCLUDED row when it's newer or has a higher `event_seq` tie-break.

Tests and verification
----------------------
- `services/billing-service/tests/war-games.cjs` contains the WarGames harness. It exercises duplicate events, out-of-order delivery, same-timestamp tie-breaks, and retry recovery.
- CI includes two checks you should keep enabled on `main`:
  - `Validate Migrations` — ensures migrations apply cleanly to a fresh DB.
  - `Integration WarGames` — runs the headless war-games tests against a Docker Postgres instance.

How to run locally
------------------
1. Ensure Docker is running.
2. From the repository root:

```powershell
npm ci
npm run build:packages
# Run the headless war-games (this starts a Postgres container and runs tests)
npm test --workspace afrogo-headless-wargames
```

Notes for maintainers
---------------------
- If you add new event-producing code paths, ensure they follow the immutable insert pattern and pass the `event_seq` (or read it after insert) into any ledger upsert.
- When adding new migrations, update the migration-runner tool and CI to include the new file; keep rollbacks alongside forward migrations.

If anything here is unclear or you'd like this note moved into a central `docs/` location, open an issue or PR and tag the billing-service owners.
