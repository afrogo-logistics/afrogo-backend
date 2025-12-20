/**
 * OPS SERVICE - Variance Review Dashboard API
 * 
 * Endpoints:
 *   GET /ops/payouts/pending-review (routes with WARN or HARD variance)
 *   POST /ops/payouts/:payoutId/approve (ops manual approval)
 *   POST /ops/payouts/:payoutId/topup (add manual top-up)
 * 
 * Access: Ops Team only (IAM role + API Gateway authorizer)
 * 
 * Status: PRODUCTION
 */

import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { Client as PgClient } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secretsManager = new SecretsManagerClient({ region: process.env.AWS_REGION });

let pgClient: PgClient | null = null;

async function getPgConnection(): Promise<PgClient> {
  if (pgClient && ! pgClient.client.activeQuery) {
    return pgClient;
  }

  const secretArn = process.env.DB_SECRET_ARN;
  const secretRes = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: secretArn!  }),
  );

  const creds = JSON.parse(secretRes.SecretString!);
  pgClient = new PgClient({
    host: creds.host,
    port: creds.port || 5432,
    database: creds.dbname,
    user: creds.username,
    password: creds.password,
  });

  await pgClient.connect();
  return pgClient;
}

// ============================================================================
// PENDING REVIEW ENDPOINT
// ============================================================================

export const pendingReviewHandler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    // Verify ops authorization
    const userRole = event.requestContext.authorizer?.claims?.['cognito:groups'];
    if (!userRole?.includes('ops-team')) {
      return {
        statusCode: 403,
        body: JSON.stringify({ message: 'Access denied: ops team only' }),
      };
    }

    const pg = await getPgConnection();

    // Find routes with high variance (> 30%) or pending manual review
    const result = await pg. query(
      `
      SELECT
        id,
        driver_id,
        route_id,
        parcels_delivered,
        planned_distance_km,
        actual_distance_km,
        variance_pct,
        rate_per_parcel,
        total_payout,
        payout_status,
        created_at,
        CASE
          WHEN variance_pct > 30 THEN 'HARD_FLAG'
          WHEN variance_pct > 10 THEN 'WARN'
          ELSE 'REVIEW'
        END as severity
      FROM driver_payouts
      WHERE payout_status IN ('ON_HOLD', 'REVIEW')
      ORDER BY variance_pct DESC, created_at ASC
      LIMIT 100
      `,
    );

    const items = result.rows.map((row: any) => ({
      payoutId: row.id,
      driverId: row.driver_id,
      routeId: row.route_id,
      parcelsDelivered: parseInt(row.parcels_delivered, 10),
      plannedKm: parseFloat(row.planned_distance_km),
      actualKm: parseFloat(row.actual_distance_km),
      variancePct: parseFloat(row.variance_pct),
      ratePerParcel: parseFloat(row.rate_per_parcel),
      totalPayoutLocked: parseFloat(row.total_payout),
      status: row.payout_status,
      severity: row.severity,
      createdAt: row.created_at,
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({
        count: items.length,
        items,
      }),
    };
  } catch (error) {
    console.error('[OpsVarianceReview] Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Failed to fetch pending reviews' }),
    };
  }
};

// ============================================================================
// APPROVE PAYOUT ENDPOINT
// ============================================================================

export const approvePayoutHandler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const userRole = event.requestContext. authorizer?.claims?.['cognito:groups'];
    if (!userRole?.includes('ops-team')) {
      return { statusCode: 403, body: JSON.stringify({ message: 'Access denied' }) };
    }

    const { payoutId } = event.pathParameters || {};
    if (!payoutId) {
      return { statusCode: 400, body: JSON.stringify({ message: 'payoutId required' }) };
    }

    const body = event.body ?  JSON.parse(event.body) : {};
    const approvalNotes = body.notes || '';

    const pg = await getPgConnection();

    await pg.query(
      `
      UPDATE driver_payouts
      SET payout_status = 'APPROVED', notes = $1, updated_at = NOW()
      WHERE id = $2
      `,
      [approvalNotes, payoutId],
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Payout approved',
        payoutId,
      }),
    };
  } catch (error) {
    console.error('[OpsVarianceReview] Approve error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Failed to approve payout' }),
    };
  }
};

// ============================================================================
// TOPUP ENDPOINT
// ============================================================================

export const addTopupHandler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const userRole = event.requestContext.authorizer?.claims?.['cognito:groups'];
    if (!userRole?. includes('ops-team')) {
      return { statusCode: 403, body: JSON.stringify({ message: 'Access denied' }) };
    }

    const { payoutId } = event.pathParameters || {};
    if (!payoutId) {
      return { statusCode: 400, body: JSON.stringify({ message: 'payoutId required' }) };
    }

    const body = event. body ? JSON.parse(event. body) : {};
    const topupAmount = parseFloat(body.topupAmount || 0);
    const reason = body.reason || 'Manual ops adjustment';

    if (topupAmount <= 0) {
      return { statusCode: 400, body: JSON.stringify({ message: 'topupAmount must be positive' }) };
    }

    const pg = await getPgConnection();

    await pg.query(
      `
      UPDATE driver_payouts
      SET
        extra_topup = extra_topup + $1,
        notes = CONCAT(notes, ' | TOPUP: ', $2, ' (', $3, ')'),
        updated_at = NOW()
      WHERE id = $4
      `,
      [topupAmount, topupAmount, reason, payoutId],
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Topup applied',
        payoutId,
        topupAmount,
      }),
    };
  } catch (error) {
    console.error('[OpsVarianceReview] Topup error:', error);
    return {
      statusCode: 500,
      body: JSON. stringify({ message: 'Failed to apply topup' }),
    };
  }
};