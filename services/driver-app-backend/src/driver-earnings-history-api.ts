/**
 * DRIVER SERVICE - Earnings History API
 * 
 * Endpoints:
 *   GET /driver/earnings/summary (today, this week, this month)
 *   GET /driver/earnings/history (paginated daily/route breakdown)
 * 
 * Data Source: driver_payouts table in Aurora
 * 
 * Status: PRODUCTION
 */

import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { Client as PgClient } from 'pg';

// Minimal DB row shape for driver_payouts used by this handler
interface DriverPayoutRow {
  id?: string;
  route_id?: string;
  created_at?: string;
  parcels_delivered?: string | number;
  planned_distance_km?: string | number;
  actual_distance_km?: string | number | null;
  variance_pct?: string | number | null;
  rate_per_parcel?: string | number;
  total_payout?: string | number;
  extra_topup?: string | number | null;
  payout_status?: string;
}
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secretsManager = new SecretsManagerClient({ region: process.env. AWS_REGION });

// Reuse PostgreSQL connection across invocations
let pgClient: PgClient | null = null;

async function getPgConnection(): Promise<PgClient> {
  if (pgClient && ! pgClient.client.activeQuery) {
    return pgClient;
  }

  const secretArn = process.env.DB_SECRET_ARN;
  if (! secretArn) throw new Error('DB_SECRET_ARN not set');

  const secretRes = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );

  if (!secretRes.SecretString) throw new Error('DB credentials not found');

  const creds = JSON.parse(secretRes.SecretString);
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
// EARNINGS SUMMARY ENDPOINT
// ============================================================================

export const summaryHandler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const driverId = event.requestContext.authorizer?.claims?.['cognito:username'];
    if (!driverId) {
      return {
        statusCode: 401,
        body: JSON. stringify({ message: 'Unauthorized' }),
      };
    }

    const period = event.queryStringParameters?.period || 'today'; // today | week | month

    const pg = await getPgConnection();

    // Calculate date ranges
    const now = new Date();
    let startDate: Date;

    switch (period) {
      case 'week':
        startDate = new Date(now);
        startDate.setDate(startDate.getDate() - 7);
        break;
      case 'month':
        startDate = new Date(now);
        startDate.setMonth(startDate.getMonth() - 1);
        break;
      case 'today':
      default:
        startDate = new Date(now);
        startDate.setHours(0, 0, 0, 0);
    }

    const result = await pg.query(
      `
      SELECT
        COUNT(*) as routes_completed,
        SUM(parcels_delivered) as total_parcels,
        SUM(planned_distance_km) as total_km,
        SUM(total_payout + COALESCE(extra_topup, 0)) as total_earned,
        AVG(variance_pct) as avg_variance_pct,
        COUNT(CASE WHEN payout_status = 'APPROVED' THEN 1 END) as approved_routes,
        COUNT(CASE WHEN payout_status = 'ON_HOLD' THEN 1 END) as pending_routes
      FROM driver_payouts
      WHERE driver_id = $1 AND created_at >= $2
      `,
      [driverId, startDate.toISOString()],
    );

    // Aggregate summary row shape
    interface SummaryRow {
      routes_completed?: string | number;
      total_parcels?: string | number;
      total_km?: string | number;
      total_earned?: string | number;
      avg_variance_pct?: string | number;
      approved_routes?: string | number;
      pending_routes?: string | number;
    }

    const summaryRow: SummaryRow = result.rows[0] ?? ({} as SummaryRow);

    return {
      statusCode: 200,
      body: JSON.stringify({
        period,
        summary: {
          routesCompleted: Number(summaryRow.routes_completed) || 0,
          totalParcels: Number(summaryRow.total_parcels) || 0,
          totalKm: Number(summaryRow.total_km) || 0,
          totalEarned: Number(summaryRow.total_earned) || 0,
          averageVariancePct: Number(summaryRow.avg_variance_pct) || 0,
          approvedRoutes: Number(summaryRow.approved_routes) || 0,
          pendingRoutes: Number(summaryRow.pending_routes) || 0,
        },
      }),
    };
  } catch (error) {
    console.error('[EarningsHistory] Summary error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Failed to fetch earnings summary' }),
    };
  }
};

// ============================================================================
// EARNINGS HISTORY ENDPOINT (Paginated)
// ============================================================================

export const historyHandler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const driverId = event.requestContext.authorizer?.claims?.['cognito:username'];
    if (!driverId) {
      return {
        statusCode: 401,
        body: JSON. stringify({ message: 'Unauthorized' }),
      };
    }

    const page = parseInt(event.queryStringParameters?.page || '0', 10);
    const limit = Math.min(parseInt(event.queryStringParameters?.limit || '20', 10), 100);
    const offset = page * limit;

    const pg = await getPgConnection();

    // Fetch payout records
    const result = await pg. query(
      `
      SELECT
        id,
        route_id,
        created_at,
        parcels_delivered,
        planned_distance_km,
        actual_distance_km,
        variance_pct,
        rate_per_parcel,
        total_payout,
        extra_topup,
        payout_status
      FROM driver_payouts
      WHERE driver_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [driverId, limit, offset],
    );

    // Fetch total count
    const countResult = await pg.query(
      `SELECT COUNT(*) FROM driver_payouts WHERE driver_id = $1`,
      [driverId],
    );

    const totalCount = parseInt(countResult.rows[0]. count, 10);
    const totalPages = Math.ceil(totalCount / limit);

    const history = result.rows.map((row: DriverPayoutRow) => {
      const created = new Date(String(row.created_at ?? Date.now()));
      return {
        routeId: String(row.route_id ?? ''),
        date: created.toISOString().split('T')[0],
        time: created.toLocaleTimeString(),
        parcelsDelivered: Number(row.parcels_delivered) || 0,
        plannedKm: Number(row.planned_distance_km) || 0,
        actualKm: Number(row.actual_distance_km ?? 0) || 0,
        variancePct: Number(row.variance_pct ?? 0) || 0,
        ratePerParcel: Number(row.rate_per_parcel) || 0,
        totalEarned: (Number(row.total_payout) || 0) + (Number(row.extra_topup) || 0),
        status: String(row.payout_status ?? ''),
      };
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        pagination: {
          page,
          limit,
          totalCount,
          totalPages,
        },
        history,
      }),
    };
  } catch (error) {
    console.error('[EarningsHistory] History error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Failed to fetch earnings history' }),
    };
  }
};