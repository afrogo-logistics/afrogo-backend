AfroGo Billing Ops README
=========================

This doc collects quick ops steps for validating and releasing Billing changes.

Local WarGames (fast)
---------------------
Prereqs: Docker installed.

1. From repo root:

   docker-compose up --build

   This starts Postgres and runs the WarGames integration tests inside the `wargames-runner` container.

Run WarGames against an external DB (staging)
----------------------------------------------
Set env vars to point to staging DB and run tests locally:

```pwsh
$env:PGHOST='staging-db-host'
$env:PGPORT='5432'
$env:PGUSER='staging-user'
$env:PGPASSWORD='...'
$env:PGDATABASE='staging-db'
$env:RUN_WAR_GAMES='1'
npm run build:packages
npm test
```

Create alarms
-------------
Run the helper (requires AWS credentials/role with PutMetricData and CloudWatch alarm creation permissions):

```pwsh
node services/billing-service/tools/create-alarms.js
```

Reconcile (daily check)
-----------------------
You can run the reconcile script locally or let the scheduled GitHub Action execute it. To run locally:

```pwsh
node services/billing-service/tools/reconcile.js
```

Making the WarGames CI job required
---------------------------------
Follow `docs/branch-protection.md` (a repo admin must do this via GitHub UI).

Release checklist
-----------------
Follow `docs/ops/release-checklist.md` before enabling strict mode in production.
