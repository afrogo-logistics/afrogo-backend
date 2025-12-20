Billing release checklist (production readiness)
==============================================

Follow these steps before enabling strict ledger enforcement in production.

1) Ensure migrations applied to DB (staging then prod)
   - Use `services/billing-service/tools/migrate-runner.js` in dry-run mode first.
   - Ensure `pgcrypto` extension exists (ops may need to create it once).

2) Run WarGames against staging Aurora
   - Use the integration workflow (see `.github/workflows/integration-wargames.yml`) by configuring staging PG secrets and triggering a `workflow_dispatch`.
   - OR run locally against staging DB credentials with `RUN_WAR_GAMES=1 npm test`.

3) Verify monitoring & alarms
   - Ensure CloudWatch metrics are enabled (set `METRICS_BACKEND=cloudwatch` for the billing service or attach a role that allows PutMetricData).
   - Create alarms (see `services/billing-service/tools/create-alarms.js`).

4) Run reconcile job on staging
   - Trigger `reconcile-daily` workflow manually (or run `node services/billing-service/tools/reconcile.js` pointing at staging DB).
   - Ensure there are no unexpected mismatches.

5) Canary rollout
   - Enable strict mode (if you have a feature flag) for a subset of merchants / invoices.
   - Monitor alarms and reconcile results closely for 24–48 hours.

6) Full rollout
   - Flip strict mode globally once canary passes and alarms are green.

Notes
-----
- Branch protection: Use `docs/branch-protection.md` to require the `war-games` job in PRs.
- If `CREATE EXTENSION pgcrypto` is not permitted by deploy role, have ops run it once with a higher-privileged account.
