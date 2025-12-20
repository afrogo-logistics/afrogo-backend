import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

const BACKEND = process.env.METRICS_BACKEND || 'console';

let cw: any = null;
if (BACKEND === 'cloudwatch') {
  cw = new CloudWatchClient({ region: process.env.AWS_REGION || 'af-south-1' });
}

function dimsToArray(dims?: Record<string, string>) {
  if (!dims) return [];
  return Object.keys(dims).map((k) => ({ Name: k, Value: String(dims[k]) }));
}

export async function increment(name: string, value = 1, dims?: Record<string, string>) {
  if (BACKEND === 'cloudwatch' && cw) {
    try {
      const cmd = new PutMetricDataCommand({
        Namespace: process.env.METRICS_NAMESPACE || 'AfroGo/Billing',
        MetricData: [{ MetricName: name, Value: value, Unit: 'Count', Dimensions: dimsToArray(dims) }],
      });
      await cw.send(cmd);
    } catch (e) {
      // fall back to console
      console.warn('[metrics] cloudwatch publish failed', String(e));
    }
  } else {
    console.log('[metrics] increment', { name, value, dims });
  }
}

export async function timing(name: string, ms: number, dims?: Record<string, string>) {
  if (BACKEND === 'cloudwatch' && cw) {
    try {
      const cmd = new PutMetricDataCommand({
        Namespace: process.env.METRICS_NAMESPACE || 'AfroGo/Billing',
        MetricData: [{ MetricName: name, Value: ms, Unit: 'Milliseconds', Dimensions: dimsToArray(dims) }],
      });
      await cw.send(cmd);
    } catch (e) {
      console.warn('[metrics] cloudwatch publish failed', String(e));
    }
  } else {
    console.log('[metrics] timing', { name, ms, dims });
  }
}

export default { increment, timing };
