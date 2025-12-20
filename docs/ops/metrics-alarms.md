Metrics & Alarms (Billing)
===========================

This document describes how to enable CloudWatch metrics and alarms for the Billing service.

1) Enable CloudWatch metrics publishing

- In `services/billing-service/src/metrics.ts` the adapter supports `METRICS_BACKEND=cloudwatch`.
- Ensure your Lambda or host has permissions to call `cloudwatch:PutMetricData`.

Minimal IAM policy:

```
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["cloudwatch:PutMetricData"],
      "Resource": "*"
    }
  ]
}
```

2) Create alarms

- Run the script (requires AWS credentials in the environment):

```
AWS_REGION=af-south-1 node services/billing-service/tools/create-alarms.js
```

This creates two alarms:
- AfroGo-Billing-EventInsertFail (fires when event_insert_fail >= 1 in a 5-minute window)
- AfroGo-Billing-LedgerUpsertFail (fires when ledger_upsert_fail >= 1 in a 5-minute window)

3) Alerting

- Configure Alarm Actions (SNS topic, pager duty, Slack) in the CloudWatch console or via IaC.

4) Verification

- Temporarily set `METRICS_BACKEND=cloudwatch` and trigger a failing flow (or use the test metric) and confirm alarm transitions to ALARM.
