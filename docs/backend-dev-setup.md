# AfroGo Backend Dev Setup

## Deploy / Destroy
- Deploy dev stack: `cd infra/cdk && npm exec cdk deploy AfroGoApiStack-Dev --require-approval never`
- Destroy dev stack: `cd infra/cdk && npm exec cdk destroy AfroGoApiStack-Dev --force`

## Database env vars (Data API)
Set once per shell:
```bash
$env:DB_RESOURCE_ARN="<aurora-cluster-arn>"
$env:DB_SECRET_ARN="<aurora-secret-arn>"
$env:DB_NAME="afrogo"
```

## Migrations (Data API runner)
- Dry run: `node tools/run-migrations-dataapi.mjs --dry-run`
- Apply: `node tools/run-migrations-dataapi.mjs`

## Verify DB
```bash
aws rds-data execute-statement --region af-south-1 --resource-arn $env:DB_RESOURCE_ARN --secret-arn $env:DB_SECRET_ARN --database $env:DB_NAME --sql "SELECT extname FROM pg_extension WHERE extname='pgcrypto';"
aws rds-data execute-statement --region af-south-1 --resource-arn $env:DB_RESOURCE_ARN --secret-arn $env:DB_SECRET_ARN --database $env:DB_NAME --sql "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('merchant_payment_events','merchant_ledger','schema_migrations');"
aws rds-data execute-statement --region af-south-1 --resource-arn $env:DB_RESOURCE_ARN --secret-arn $env:DB_SECRET_ARN --database $env:DB_NAME --sql "SELECT filename, applied_at FROM schema_migrations ORDER BY filename;"
aws rds-data execute-statement --region af-south-1 --resource-arn $env:DB_RESOURCE_ARN --secret-arn $env:DB_SECRET_ARN --database $env:DB_NAME --sql "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN ('merchant_payment_events','merchant_ledger') ORDER BY tablename, indexname;"
```

## CloudWatch alarms (billing)
```bash
AWS_REGION=af-south-1 node services/billing-service/tools/create-alarms.js
aws cloudwatch describe-alarms --region af-south-1 --alarm-names AfroGo-Billing-EventInsertFail AfroGo-Billing-LedgerUpsertFail --query "MetricAlarms[].{Name:AlarmName,State:StateValue,Namespace:Namespace,Metric:MetricName,Threshold:Threshold,Period:Period,EvaluationPeriods:EvaluationPeriods}" --output table
```

## WarGames / integration smoke
```bash
cd /path/to/afrogo-backend
docker-compose up --build --abort-on-container-exit
```

## Frontend handoff (.env template)
```
EXPO_PUBLIC_API_BASE_URL=https://edqtfqoip7.execute-api.af-south-1.amazonaws.com/v1/
EXPO_PUBLIC_AWS_REGION=af-south-1
EXPO_PUBLIC_COGNITO_USER_POOL_ID=af-south-1_IshtpyImr
EXPO_PUBLIC_COGNITO_CLIENT_ID=4c1tntds0c41tnq66kaogech4u
```
