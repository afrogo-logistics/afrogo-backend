/**
 * ROUTING SERVICE - Batch Route Generation
 *
 * Responsibilities:
 *  - Receive route candidates (from upstream or batch planner)
 *  - Quote each candidate via Rate Engine
 *  - Persist ACCEPTED routes to Routes DynamoDB table with payoutSnapshot
 *  - Send REJECTED routes to Ops SQS for manual handling
 *  - Emit CloudWatch metrics and optionally notify Driver Service
 *
 * Notes:
 *  - routeId is generated without "ROUTE#" prefix; DynamoDB PK uses "ROUTE#<routeId>"
 *  - Uses hardened RateEngineClient (secrets-backed) via getRateEngineClient()
 *
 * Environment variables:
 *  - ROUTES_TABLE_NAME
 *  - RATE_ENGINE_API_URL
 *  - RATE_ENGINE_API_SECRET_ARN
 *  - OPS_REVIEW_QUEUE_URL
 *  - REGION
 *
 * Status: PRODUCTION READY
 * Last Updated: 2025-12-01
 */

import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { v4 as uuidv4 } from 'uuid';
import { getRateEngineClient } from '../lib/rate-engine-client'; // hardened client factory
import type { RouteQuoteResponse } from '../../rate-engine/src/engine/domain';

const REGION = process.env.REGION || process.env.AWS_REGION || 'af-south-1';
const ddb = new DynamoDBClient({ region: REGION });
const cloudwatch = new CloudWatchClient({ region: REGION });
const sqs = new SQSClient({ region: REGION });

const ROUTES_TABLE = process.env.ROUTES_TABLE_NAME || 'Routes';
const OPS_REVIEW_QUEUE_URL = process.env.OPS_REVIEW_QUEUE_URL || '';
const RATE_ENGINE_API_SECRET_ARN = process.env.RATE_ENGINE_API_SECRET_ARN || '';
const RATE_ENGINE_API_URL = process.env.RATE_ENGINE_API_URL || '';

/**
 * Parcel minimal shape for candidate
 */
export interface Parcel {
  parcelId: string;
  lat?: number;
  lon?: number;
  merchantId?: string;
}

/**
 * Candidate route from planner
 */
export interface RouteCandidate {
  zoneId: string;
  parcels: Parcel[];
  plannedDistanceKm: number;
  estimatedDurationMin?: number;
}

/**
 * Result per candidate
 */
interface GeneratedResult {
  routeId?: string;
  status: 'ACCEPTED' | 'REJECTED' | 'ERROR';
  quote?: RouteQuoteResponse | null;
  reason?: string;
  candidateIndex: number;
}

// small helper
function toIso() {
  return new Date().toISOString();
}

/**
 * Persist route item (METADATA record) to Routes table
 */
async function putRouteItem({
  routeId,
  serviceDate,
  zoneId,
  candidate,
  quote,
}: {
  routeId: string;
  serviceDate: string;
  zoneId: string;
  candidate: RouteCandidate;
  quote: RouteQuoteResponse;
}) {
  const now = toIso();

  const payoutSnapshot = {
    baseRate: quote.configSnapshot?.baseRateZar ?? null,
    kmFactor: quote.configSnapshot?.kmFactorZar ?? null,
    ratePerParcel: quote.ratePerParcel,
    parcelCount: candidate.parcels.length,
    totalPayout: quote.totalPayout,
    currency: quote.currency,
    lockedAt: quote.calculatedAt,
    guardrailStatus: quote.guardrailStatus,
    guardrailDetails: quote.guardrailDetails ?? null,
    modelVersion: quote.modelVersion,
  };

  const item: Record<string, any> = {
    PK: { S: `ROUTE#${routeId}` },
    SK: { S: 'METADATA' },
    routeId: { S: routeId },
    serviceDate: { S: serviceDate },
    zoneId: { S: zoneId },
    driverId: { S: 'UNASSIGNED' },
    status: { S: 'OFFERED' },
    stopCount: { N: String(candidate.parcels.length) },
    plannedDistanceKm: { N: String(candidate.plannedDistanceKm) },
    estimatedDurationMin: { N: String(candidate.estimatedDurationMin ?? 0) },
    payoutModel: { S: quote.modelVersion },
    payoutSnapshot: { S: JSON.stringify(payoutSnapshot) },
    parcels: { S: JSON.stringify(candidate.parcels.map((p) => p.parcelId)) },
    actuals: { S: JSON.stringify({ telemetryKm: 0, completedStops: 0, variancePct: 0, finalizedAt: null }) },
    createdAt: { S: now },
    updatedAt: { S: now },
  };

  await ddb.send(new PutItemCommand({ TableName: ROUTES_TABLE, Item: item }));
}

/**
 * Send rejected route message to Ops SQS
 */
async function sendRejectedToOps({
  routeId,
  zoneId,
  candidate,
  quote,
}: {
  routeId: string;
  zoneId: string;
  candidate: RouteCandidate;
  quote: RouteQuoteResponse | null;
}) {
  if (!OPS_REVIEW_QUEUE_URL) {
    console.warn('[Routing] OPS_REVIEW_QUEUE_URL not configured; skipping ops alert');
    return;
  }

  const payload = {
    event: 'ROUTE_REJECTED',
    routeId,
    zoneId,
    parcelCount: candidate.parcels.length,
    plannedDistanceKm: candidate.plannedDistanceKm,
    quote: quote ?? null,
    timestamp: toIso(),
  };

  await sqs.send(new SendMessageCommand({ QueueUrl: OPS_REVIEW_QUEUE_URL, MessageBody: JSON.stringify(payload) }));
}

/**
 * Emit routing metrics to CloudWatch
 */
async function emitRoutingMetrics(generated: GeneratedResult[]) {
  try {
    const accepted = generated.filter((r) => r.status === 'ACCEPTED').length;
    const rejected = generated.filter((r) => r.status === 'REJECTED').length;
    const errors = generated.filter((r) => r.status === 'ERROR').length;

    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: 'AfroGo/Routing',
        MetricData: [
          { MetricName: 'RoutesGenerated', Value: generated.length, Unit: 'Count', Timestamp: new Date() },
          { MetricName: 'RoutesAccepted', Value: accepted, Unit: 'Count', Timestamp: new Date() },
          { MetricName: 'RoutesRejected', Value: rejected, Unit: 'Count', Timestamp: new Date() },
          { MetricName: 'RoutesErrored', Value: errors, Unit: 'Count', Timestamp: new Date() },
        ],
      }),
    );
  } catch (err) {
    console.warn('[Routing] emitRoutingMetrics failed (non-blocking):', String(err));
  }
}

/**
 * Lambda handler (HTTP) to accept a batch of route candidates and generate routes.
 *
 * POST body:
 * {
 *   "serviceDate": "2025-12-01",
 *   "zoneId": "SOWETO_SOUTH",        // optional global zone
 *   "candidates": [ RouteCandidate, ... ]
 * }
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const requestId = uuidv4();
  const start = Date.now();
  const results: GeneratedResult[] = [];

  try {
    if (!event.body) return { statusCode: 400, body: JSON.stringify({ error: 'Request body required' }) };

    let body: any;
    try {
      body = JSON.parse(event.body);
    } catch (err) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const serviceDate = String(body.serviceDate || new Date().toISOString().split('T')[0]);
    const candidates: RouteCandidate[] = Array.isArray(body.candidates) ? body.candidates : [];
    const zoneIdFallback: string | undefined = body.zoneId;

    if (candidates.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'candidates array required' }) };
    }

    // Rate engine client (hardened); uses secret ARN for API key
    const rateClient = getRateEngineClient({
      baseURL: RATE_ENGINE_API_URL,
      secretArn: RATE_ENGINE_API_SECRET_ARN,
    });

    // Process candidates sequentially to avoid spamming Rate Engine; could be parallel with throttling
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const zoneId = candidate.zoneId ?? zoneIdFallback ?? 'UNKNOWN_ZONE';
      const parcelCount = candidate.parcels.length;
      const routeId = `${serviceDate}-${zoneId}-${uuidv4()}`; // routeId without "ROUTE#" prefix

      try {
        // Quote the route
        const quoteReq = {
          routeId,
          plannedDistanceKm: candidate.plannedDistanceKm,
          parcelCount,
          zoneId,
        };

        // Fixed: call the client method with the request only
        const quote = await rateClient.quoteRoute(quoteReq);

        if (quote.status !== 'ACCEPTED') {
          // Rejected by guardrails
          await sendRejectedToOps({ routeId, zoneId, candidate, quote });
          results.push({ candidateIndex: i, routeId, status: 'REJECTED', quote });
          continue;
        }

        // Persist route item with payout snapshot
        await putRouteItem({
          routeId,
          serviceDate,
          zoneId,
          candidate,
          quote,
        });

        // Optionally: notify driver service or publish EventBridge event (left as integration point)
        results.push({ candidateIndex: i, routeId, status: 'ACCEPTED', quote });
      } catch (err: any) {
        console.error('[Routing] Error processing candidate', { index: i, zoneId, err: String(err) });
        // Send to ops queue for manual investigation
        try {
          await sendRejectedToOps({ routeId, zoneId, candidate, quote: null });
        } catch (qerr) {
          console.warn('[Routing] Failed to enqueue error to ops queue (non-blocking):', String(qerr));
        }
        results.push({ candidateIndex: i, routeId, status: 'ERROR', reason: String(err) });
      }
    }

    // Emit metrics (best-effort)
    await emitRoutingMetrics(results);

    const durationMs = Date.now() - start;
    console.log('[Routing] Batch generation complete', { requestId, durationMs, accepted: results.filter(r => r.status === 'ACCEPTED').length });

    return {
      statusCode: 200,
      body: JSON.stringify({
        requestId,
        serviceDate,
        results,
        durationMs,
      }),
    };
  } catch (err: any) {
    console.error('[Routing] Handler error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Route generation failed', details: err instanceof Error ? err.message : String(err) }) };
  }
};