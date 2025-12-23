import { CloudWatchClient, PutMetricAlarmCommand } from '@aws-sdk/client-cloudwatch';

/**
 * Simple script to create a few CloudWatch alarms for billing metrics.
 *
 * Usage:
 *   AWS_REGION=af-south-1 AWS_PROFILE=... node services/billing-service/tools/create-alarms.js
 *
 * The script reads environment variables for namespace and alarm names.
 */

const REGION = process.env.AWS_REGION || 'af-south-1';
const NAMESPACE = process.env.METRICS_NAMESPACE || 'AfroGo/Billing';

const cw = new CloudWatchClient({ region: REGION });

async function putAlarm(name, metricName, threshold) {
  const params = {
    AlarmName: name,
    ComparisonOperator: 'GreaterThanThreshold',
    EvaluationPeriods: 1,
    MetricName: metricName,
    Namespace: NAMESPACE,
    Period: 300,
    Threshold: threshold,
    Statistic: 'Sum',
    ActionsEnabled: false, // set to true and configure actions as needed
    AlarmDescription: `Alarm for ${metricName}`,
  };
  const cmd = new PutMetricAlarmCommand(params);
  await cw.send(cmd);
  console.log('Created/updated alarm', name);
}

async function run() {
  console.log('Creating alarms in namespace', NAMESPACE);
  await putAlarm('AfroGo-Billing-EventInsertFail', 'event_insert_fail', 1);
  await putAlarm('AfroGo-Billing-LedgerUpsertFail', 'ledger_upsert_fail', 1);
  console.log('Done');
}

run().catch((err) => {
  console.error('Failed to create alarms', (err && err.stack) || err);
  process.exit(1);
});
