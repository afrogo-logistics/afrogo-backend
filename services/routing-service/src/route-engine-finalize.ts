/**
 * RATE ENGINE - Finalize Payout Lambda (HTTP)
 *
 * - Uses server-side truth (Routes table) for plannedDistanceKm & payout snapshot
 * - Evaluates variance between planned and actual distances
 * - Writes payout ledger to Aurora (driver_payouts) - server truth only
 * - Updates Routes DynamoDB item with actuals
 * - Writes audit entry (DynamoDB) + emits CloudWatch metrics (best-effort)
 *
 * Production considerations applied:
 *  - Reuse PostgreSQL client across Lambda invocations (no per-invocation close)
 *  - DB credentials from Secrets Manager
 *  - Planned distance taken from DynamoDB (never trust client)
 *  - Parcels delivered validated vs snapshot.parcelCount (warn / reject as appropriate)
 *
 * Status: PRODUCTION READY
 * Last Updated: 2025-12-01
 */

import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { v4 as uuidv4 } from 'uuid';
import { Client as PgClient } from 'pg';

import { RateEngineConfig, RouteFinalizeRequest, RouteFinalizeResponse, PayoutAuditEntry } from '@afrogo/rate-engine-core/engine-domain';
import { evaluateVariance, determineFinalPayoutStatus } from '@afrogo/rate-engine-core/engine-modelc';

// -----------------------------
// Clients & env
// -----------------------------

const REGION = process.env.AWS_REGION || 'af-south-1';
const ddb = new DynamoDBClient({ region: REGION });
const secretsManager = new SecretsManagerClient({ region: REGION });
const cloudwatch = new CloudWatchClient({ region: REGION });

const ROUTES_TABLE = process.env.ROUTES_TABLE || process.env.ROUTES_TABLE_NAME || 'Routes';
const AUDIT_TABLE = process.env.AUDIT_TABLE_NAME || 'PayoutAuditLog';
const DB_SECRET_ARN = process.env.DB_SECRET_ARN || ''; // required
const DB_MAX_RETRIES = parseInt(process.env.DB_MAX_RETRIES || '2', 10);

// In-memory cached PG client across Lambda invocations (do NOT .end())
let pgClient: PgClient | null = null;
let pgConnInitialized = false;

// -----------------------------
// Helpers
// -----------------------------

async function getPgClient(): Promise<PgClient> {
  if (pgClient && pgConnInitialized) {
    return pgClient;
  }

  if (!DB_SECRET_ARN) throw new Error('DB_SECRET_ARN not configured');

  const secret = await secretsManager.send(new GetSecretValueCommand({ SecretId: DB_SECRET_ARN }));
  if (!secret.SecretString) throw new Error('DB secret empty');

  const creds = JSON.parse(secret.SecretString);

  pgClient = new PgClient({
    host: creds.host,
    port: creds.port || 5432,
    database: creds.dbname || creds.database,
    user: creds.username || creds.user,
    password: creds.password,
    ssl: creds.ssl !== 'false' && creds.ssl !== false, // allow toggling
    statement_timeout: 60000,
    query_timeout: 60000,
  });

  await pgClient.connect();
  pgConnInitialized = true;
  console.log('[Finalize] PostgreSQL connection established (reused across invocations)');
  return pgClient;
}

async function emitMetrics(payoutStatus: string, variancePct: number): Promise<void> {
  try {
    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: 'AfroGo/RateEngine',
        MetricData: [
          { MetricName: 'PayoutsFinalized', Value: 1, Unit: 'Count', Timestamp: new Date() },
          { MetricName: `Payouts${payoutStatus}`, Value: 1, Unit: 'Count', Timestamp: new Date() },
          { MetricName: 'VariancePct', Value: Math.abs(variancePct), Unit: 'Percent', Timestamp: new Date() },
        ],
      }),
    );
  } catch (err) {
    console.warn('[Finalize] CloudWatch emit failed (non-blocking):', String(err));
  }
}

async function writeAudit(entry: PayoutAuditEntry): Promise<void> {
  try {
    const item: Record<string, any> = {
      PK: { S: `PAYOUT_AUDIT#${entry.routeId}` },
      SK: { S: entry.timestamp },
      auditId: { S: entry.auditId },
      routeId: { S: entry.routeId },
      eventType: { S: entry.eventType },
      modelVersion: { S: entry.modelVersion },
      payload: { S: JSON.stringify(entry) },
    };
    await ddb.send(new PutItemCommand({ TableName: AUDIT_TABLE, Item: item }));
  } catch (err) {
    console.warn('[Finalize] Audit write failed (non-blocking):', String(err));
  }
}

function sanitizeString(v?: any): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  const t = s.trim();
  return t.length > 0 ? t : undefined;
}

// Minimal config loader with defaults (finalize uses only modelVersion/base & kmFactor for ledger)
function loadDefaultConfig(): RateEngineConfig {
  return {
    baseRateZar: 30,
    kmFactorZar: 0.125,
    minRatePerParcelZar: 25,
    maxRatePerParcelZar: 80,
    minStops: 25,
    maxStops: 45,
    maxRouteKm: 220,
    maxKmPerStop: 7,
    varianceWarnPct: 10,
    varianceHardPct: 30,
    modelVersion: 'MODEL_C_V1',
    createdAt: new Date(),
  };
}

// -----------------------------
// Lambda handler
// -----------------------------

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const auditId = uuidv4();
  const start = Date.now();

  try {
    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Request body required' }) };
    }

    let body: any;
    try {
      body = JSON.parse(event.body);
    } catch (err) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    // client-provided fields (we'll ignore payout numbers from client)
    const request: RouteFinalizeRequest = {
      routeId: sanitizeString(body.routeId) || '',
      driverId: sanitizeString(body.driverId) || '',
      actualDistanceKm: Number(body.actualDistanceKm),
      parcelsDelivered: Number(body.parcelsDelivered),
      // optional client snapshot fields (ignored for payout calculation)
      ratePerParcel: body.ratePerParcel,
      totalPayoutPlanned: body.totalPayoutPlanned,
    };

    if (!request.routeId || !request.driverId || !Number.isFinite(request.actualDistanceKm) || !Number.isFinite(request.parcelsDelivered)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'routeId, driverId, actualDistanceKm, parcelsDelivered required' }) };
    }

    // 1) Load route & snapshot from DynamoDB (server truth)
    const routeKey = { PK: { S: `ROUTE#${request.routeId}` }, SK: { S: 'METADATA' } };
    const routeRes = await ddb.send(new GetItemCommand({ TableName: ROUTES_TABLE, Key: routeKey }));

    if (!routeRes.Item) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Route not found' }) };
    }

    // Parse plannedDistanceKm from DB (server truth)
    const plannedDistanceKm = Number(routeRes.Item.plannedDistanceKm?.N ?? routeRes.Item.plannedDistanceKm?.S ?? 0);
    const snapshotRaw = routeRes.Item.payoutSnapshot?.S ? JSON.parse(routeRes.Item.payoutSnapshot.S) : {};
    const snapshotParcelCount = Number(snapshotRaw.parcelCount ?? routeRes.Item.stopCount?.N ?? 0);
    const snapshotRatePerParcel = Number(snapshotRaw.ratePerParcel ?? 0);
    const snapshotTotalPayout = Number(snapshotRaw.totalPayout ?? 0);

    // 2) Validate parcelsDelivered <= snapshotParcelCount (warn or error)
    if (request.parcelsDelivered > snapshotParcelCount) {
      // Log and reject — this may indicate double-scan or incorrect telemetry
      console.warn('[Finalize] parcelsDelivered exceeds planned parcelCount', {
        routeId: request.routeId,
        parcelsDelivered: request.parcelsDelivered,
        plannedParcelCount: snapshotParcelCount,
      });

      // Return 400 to indicate client provided inconsistent actuals
      return { statusCode: 400, body: JSON.stringify({ error: 'parcelsDelivered exceeds planned parcel count' }) };
    }

    // 3) Evaluate variance (use DB plannedDistanceKm)
    const cfg = loadDefaultConfig();
    const varianceEval = evaluateVariance(plannedDistanceKm, request.actualDistanceKm, cfg);
    const payoutStatus = determineFinalPayoutStatus(varianceEval);

    // 4) Write ledger row to Aurora (server truth only)
    const pg = await getPgClient();

    const payoutId = uuidv4();
    const now = new Date().toISOString();

    // Compose ledger values using server-side snapshot for rate and total
    const ledgerValues: any = {
      id: payoutId,
      driverId: request.driverId,
      routeId: request.routeId,
      payoutModel: cfg.modelVersion,
      parcelsDelivered: request.parcelsDelivered,
      plannedDistanceKm,
      actualDistanceKm: request.actualDistanceKm,
      variancePct: varianceEval.variancePct,
      baseRatePerParcel: Number(snapshotRaw.baseRate ?? cfg.baseRateZar),
      kmFactorPerKm: Number(snapshotRaw.kmFactor ?? cfg.kmFactorZar),
      ratePerParcel: Number(
        snapshotRatePerParcel || (cfg.baseRateZar + cfg.kmFactorZar * plannedDistanceKm),
      ),
      // default to snapshot if present; overwritten below if not
      totalPayout: snapshotTotalPayout > 0 ? snapshotTotalPayout : 0,
      payoutStatus,
      createdAt: now,
      updatedAt: now,
    };

    // Ensure totalPayout uses snapshot total if available, otherwise compute from rate * delivered parcels
    const computedRate = ledgerValues.ratePerParcel;
    ledgerValues.totalPayout =
      snapshotTotalPayout > 0
        ? snapshotTotalPayout
        : Math.round(computedRate * request.parcelsDelivered * 100) / 100;

    // Insert into driver_payouts
    const insertQuery = `
      INSERT INTO driver_payouts (
        id,
        driver_id,
        route_id,
        payout_model,
        parcels_delivered,
        planned_distance_km,
        actual_distance_km,
        variance_pct,
        base_rate_per_parcel,
        km_factor_per_km,
        rate_per_parcel,
        total_payout,
        payout_status,
        created_at,
        updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
      )
    `;

    const insertParams = [
      ledgerValues.id,
      ledgerValues.driverId,
      ledgerValues.routeId,
      ledgerValues.payoutModel,
      ledgerValues.parcelsDelivered,
      ledgerValues.plannedDistanceKm,
      ledgerValues.actualDistanceKm,
      ledgerValues.variancePct,
      ledgerValues.baseRatePerParcel,
      ledgerValues.kmFactorPerKm,
      ledgerValues.ratePerParcel,
      ledgerValues.totalPayout,
      ledgerValues.payoutStatus,
      ledgerValues.createdAt,
      ledgerValues.updatedAt,
    ];

    // Retry simple times on transient DB issues
    let inserted = false;
    let lastPgError: any = null;
    for (let attempt = 0; attempt <= DB_MAX_RETRIES; attempt++) {
      try {
        await pg.query(insertQuery, insertParams);
        inserted = true;
        break;
      } catch (pgErr) {
        lastPgError = pgErr;
        console.warn('[Finalize] PostgreSQL insert attempt failed', { attempt, err: String(pgErr) });
        // small backoff
        await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
      }
    }

    if (!inserted) {
      console.error('[Finalize] Failed to write payout ledger after retries', lastPgError);
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to write payout ledger' }) };
    }

    // 5) Update Routes DynamoDB item with actuals and status
    const actuals = {
      telemetryKm: request.actualDistanceKm,
      completedStops: request.parcelsDelivered,
      variancePct: varianceEval.variancePct,
      finalizedAt: now,
    };

    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: ROUTES_TABLE,
          Key: routeKey,
          UpdateExpression: 'SET #status = :status, #actuals = :actuals, #updated = :updated',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#actuals': 'actuals',
            '#updated': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':status': { S: 'COMPLETED' },
            ':actuals': { S: JSON.stringify(actuals) },
            ':updated': { S: now },
          },
        }),
      );
    } catch (dbErr) {
      console.warn('[Finalize] Failed to update route actuals (non-blocking):', dbErr);
      // Not fatal — payout ledger exists; raise alert via metrics
    }

    // 6) Audit + metrics (best-effort)
    const auditEntry: PayoutAuditEntry = {
      auditId,
      routeId: request.routeId,
      driverId: request.driverId,
      timestamp: now,
      eventType: 'PAYOUT_FINALIZED',
      modelVersion: cfg.modelVersion,
      config: { baseRateZar: cfg.baseRateZar, kmFactorZar: cfg.kmFactorZar },
      request: {
        routeId: request.routeId,
        driverId: request.driverId,
        plannedDistanceKm,
        actualDistanceKm: request.actualDistanceKm,
        parcelsDelivered: request.parcelsDelivered,
      },
      response: {
        auditId,
        payoutStatus,
        variancePct: varianceEval.variancePct,
        varianceStatus: varianceEval.status,
        finalPayoutAmount: ledgerValues.totalPayout,
        totalPayout: ledgerValues.totalPayout,
        topupRequired: false,
      },
    };

    // fire and forget
    await Promise.all([writeAudit(auditEntry), emitMetrics(payoutStatus, varianceEval.variancePct)]);

    // 7) Return response
    const response: RouteFinalizeResponse = {
      auditId,
      payoutStatus: payoutStatus as RouteFinalizeResponse['payoutStatus'],
      variancePct: varianceEval.variancePct,
      varianceStatus: varianceEval.status,
      finalPayoutAmount: ledgerValues.totalPayout,
      topupRequired: false,
      // include totalPayout if the consumer expects it; the domain type may also include it
      totalPayout: ledgerValues.totalPayout,
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'X-Audit-ID': auditId },
      body: JSON.stringify(response),
    };
  } catch (err: any) {
    console.error('[Finalize] Handler error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Payout finalization failed', details: err instanceof Error ? err.message : String(err) }),
    };
  } finally {
    const dur = Date.now() - start;
    console.log('[Finalize] Completed', { auditId, durationMs: dur });
    // Note: we do NOT close pgClient here to allow connection reuse across Lambda invocations.
  }
};