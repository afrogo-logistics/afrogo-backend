/**
 * LAMBDA: Quote Route Payout
 * 
 * Triggered by:
 *   1. Routing Service (batch optimization 06:30 AM)
 *   2. Driver App (preview before acceptance)
 *   3.  Merchant Dashboard (what-if simulations)
 * 
 * Responsibility:
 *   - Load config from SSM
 *   - Validate request
 *   - Quote route using Model C
 *   - Write audit log to DynamoDB
 *   - Emit CloudWatch metrics
 *   - Return response
 * 
 * SLA: < 500ms p99
 * 
 * Status: PRODUCTION
 */

import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  SSMClient,
  GetParametersCommand,
} from '@aws-sdk/client-ssm';
import {
  DynamoDBClient,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  RateEngineConfig,
  RouteQuoteRequest,
  RateEngineError,
  ErrorCodes,
  PayoutAuditEntry,
} from './engine-domain';
import { quoteRoute } from './engine-modelc';

// ============================================================================
// CLIENTS & INITIALIZATION
// ============================================================================

const ssm = new SSMClient({ region: process.env.AWS_REGION });
const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION });
const cloudwatch = new CloudWatchClient({ region: process.env.AWS_REGION });

// Cached config (cold start optimization)
let CONFIG: RateEngineConfig | null = null;
let CONFIG_LOAD_TIME = 0;

// Config cache TTL (5 minutes)
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

// ============================================================================
// CONFIG LOADER
// ============================================================================

async function loadConfig(): Promise<RateEngineConfig> {
  const now = Date.now();

  // Check cache
  if (CONFIG && now - CONFIG_LOAD_TIME < CONFIG_CACHE_TTL_MS) {
    return CONFIG;
  }

  console.log('[RateEngine] Loading config from SSM Parameter Store.. .');

  const cmd = new GetParametersCommand({
    Names: [
      '/afrogo/rate-engine/base-rate-zar',
      '/afrogo/rate-engine/km-factor-zar',
      '/afrogo/rate-engine/min-rate-per-parcel-zar',
      '/afrogo/rate-engine/max-rate-per-parcel-zar',
      '/afrogo/rate-engine/min-stops',
      '/afrogo/rate-engine/max-stops',
      '/afrogo/rate-engine/max-route-km',
      '/afrogo/rate-engine/max-km-per-stop',
      '/afrogo/rate-engine/variance-warn-pct',
      '/afrogo/rate-engine/variance-hard-pct',
      '/afrogo/rate-engine/model-version',
    ],
    WithDecryption: false,
  });

  const res = await ssm.send(cmd);

  if (! res.Parameters) {
    throw new RateEngineError(
      ErrorCodes.CONFIG_LOAD_FAILED,
      500,
      'No configuration parameters found in SSM',
    );
  }

  // Build a typed map from SSM response. Parameter.Name/Value can be undefined
  // so keep string|undefined and let callers provide fallbacks.
  const entries: [string, string | undefined][] = res.Parameters.map((p: any) => [p.Name ?? '', p.Value]);

  const m = new Map<string, string | undefined>(entries);

  CONFIG = {
    baseRateZar: parseFloat(m.get('/afrogo/rate-engine/base-rate-zar') || '30'),
    kmFactorZar: parseFloat(m.get('/afrogo/rate-engine/km-factor-zar') || '0.125'),
    minRatePerParcelZar: parseFloat(m.get('/afrogo/rate-engine/min-rate-per-parcel-zar') || '25'),
    maxRatePerParcelZar: parseFloat(m.get('/afrogo/rate-engine/max-rate-per-parcel-zar') || '80'),
    minStops: parseInt(m.get('/afrogo/rate-engine/min-stops') || '25', 10),
    maxStops: parseInt(m.get('/afrogo/rate-engine/max-stops') || '45', 10),
    maxRouteKm: parseFloat(m.get('/afrogo/rate-engine/max-route-km') || '220'),
    maxKmPerStop: parseFloat(m.get('/afrogo/rate-engine/max-km-per-stop') || '7'),
    varianceWarnPct: parseFloat(m.get('/afrogo/rate-engine/variance-warn-pct') || '10'),
    varianceHardPct: parseFloat(m.get('/afrogo/rate-engine/variance-hard-pct') || '30'),
    modelVersion: m.get('/afrogo/rate-engine/model-version') || 'MODEL_C_V1',
    createdAt: new Date(),
  };

  CONFIG_LOAD_TIME = now;

  console. log('[RateEngine] Config loaded:', {
    baseRateZar: CONFIG.baseRateZar,
    kmFactorZar: CONFIG.kmFactorZar,
    modelVersion: CONFIG.modelVersion,
  });

  return CONFIG;
}

// ============================================================================
// AUDIT LOGGER
// ============================================================================

async function logAudit(entry: PayoutAuditEntry): Promise<void> {
  try {
    await dynamodb.send(
      new PutItemCommand({
        TableName: process.env.AUDIT_TABLE_NAME || 'PayoutAuditLog',
        Item: {
          PK: { S: `PAYOUT_AUDIT#${entry.routeId}` },
          SK: { S: entry.timestamp },
          auditId: { S: entry.auditId },
          driverId: { S: entry. driverId },
          eventType: { S: entry.eventType },
          modelVersion: { S: entry.modelVersion },
          payload: { S: JSON.stringify(entry) },
        },
      }),
    );
  } catch (err) {
    // Log but don't fail the request
    console.warn('[RateEngine] Audit write failed (non-blocking):', err);
  }
}

// ============================================================================
// METRICS EMITTER
// ============================================================================

async function emitMetrics(
  accepted: boolean,
  ratePerParcel: number,
  plannedKm: number,
): Promise<void> {
  try {
    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: 'AfroGo/RateEngine',
        MetricData: [
          {
            MetricName: 'QuoteRequests',
            Value: 1,
            Unit: 'Count',
            Timestamp: new Date(),
          },
          {
            MetricName: accepted ? 'QuotesAccepted' : 'QuotesRejected',
            Value: 1,
            Unit: 'Count',
            Timestamp: new Date(),
          },
              ...(accepted
            ? [
                {
                  MetricName: 'RatePerParcel',
                  Value: ratePerParcel,
                  Unit: 'None',
                  Timestamp: new Date(),
                },
                {
                  MetricName: 'PlannedKm',
                  Value: plannedKm,
                  Unit: 'None',
                  Timestamp: new Date(),
                },
              ]
            : []),
        ],
      }),
    );
  } catch (err) {
    console.warn('[RateEngine] Metrics emit failed (non-blocking):', err);
  }
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const requestId = uuidv4();
  const startTime = Date.now();

  console.log('[RateEngine] Request:', {
    requestId,
    path: event.rawPath,
    method: event. requestContext.http.method,
  });

  try {
    // Parse request body
    if (! event.body) {
      throw new RateEngineError(
        ErrorCodes.INVALID_REQUEST,
        400,
        'Request body is required',
      );
    }

    let req: RouteQuoteRequest;
    try {
      req = JSON.parse(event.body);
    } catch (err) {
      throw new RateEngineError(
        ErrorCodes. INVALID_REQUEST,
        400,
        'Invalid JSON in request body',
        { parseError: String(err) },
      );
    }

    // Validate request fields
    if (!req.routeId || req.plannedDistanceKm === undefined || req.parcelCount === undefined) {
      throw new RateEngineError(
        ErrorCodes.INVALID_REQUEST,
        400,
        'Missing required fields: routeId, plannedDistanceKm, parcelCount',
      );
    }

    // Load config
    const config = await loadConfig();

    // Quote the route
    const response = quoteRoute(req, config);

    // Emit metrics
    await emitMetrics(
      response.status === 'ACCEPTED',
      response.ratePerParcel,
      req.plannedDistanceKm,
    );

    // Log to audit trail
    await logAudit({
      auditId: requestId,
      routeId: req.routeId,
      driverId: req.driverId || 'UNKNOWN',
      timestamp: new Date(). toISOString(),
      eventType: 'QUOTE_CALCULATED',
      modelVersion: config. modelVersion,
      config: {
        baseRateZar: config.baseRateZar,
        kmFactorZar: config.kmFactorZar,
      },
      request: req,
      response,
    });

    console.log('[RateEngine] Quote calculated:', {
      requestId,
      status: response.status,
      ratePerParcel: response. ratePerParcel,
      totalPayout: response.totalPayout,
      duration: Date.now() - startTime,
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
      },
      body: JSON.stringify(response),
    };
  } catch (err: any) {
    const errorResponse = {
      error: err.code || 'INTERNAL_ERROR',
      message: err.message,
      requestId,
    };

    console.error('[RateEngine] Error:', {
      requestId,
      error: err.code || err.message,
      context: err.context,
      duration: Date.now() - startTime,
    });

    return {
      statusCode: err.statusCode || 500,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
      },
      body: JSON.stringify(errorResponse),
    };
  }
};