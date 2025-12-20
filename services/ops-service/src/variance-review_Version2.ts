/**
 * OPS SERVICE - Variance Review API (updated to use pooled PG)
 *
 * - Uses shared pg-client.ts helpers: withPgClient, withPgTransaction, queryWithRetry
 * - Writes audit entries to DynamoDB (best-effort)
 *
 * Env:
 * - PG_SECRET_ARN (used by pg-client)
 * - AUDIT_TABLE_NAME (optional)
 */

import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { withPgClient, withPgTransaction, queryWithRetry } from './pg-client';

const REGION = process.env.AWS_REGION || process.env.REGION || 'af-south-1';
const PG_MAX_RETRIES = parseInt(process.env.PG_MAX_RETRIES || '2', 10);
const AUDIT_TABLE = process.env.AUDIT_TABLE_NAME || 'PayoutAuditLog';

const ddb = new DynamoDBClient({ region: REGION });

async function writeAudit(entry: {
  auditId: string;
  routeId?: string;
  routePayoutId?: string;
  eventType: string;
  details?: Record<string, any>;
  modelVersion?: string;
}) {
  try {
    const item: Record<string, any> = {
      PK: { S: `PAYOUT_AUDIT#${entry.routePayoutId ?? uuidv4()}` },
      SK: { S: new Date().toISOString() },
      auditId: { S: entry.auditId },
      eventType: { S: entry.eventType },
      payload: { S: JSON.stringify(entry) },
    };
    if (entry.routeId) item.routeId = { S: entry.routeId };
    await ddb.send(new PutItemCommand({ TableName: AUDIT_TABLE, Item: item }));
  } catch (err) {
    console.warn('[Ops] Audit write failed (non-blocking):', String(err));
  }
}

/* --------------------------------------------------------------------------
   Handlers (listPendingPayouts, approvePayout, topupPayout)
   -------------------------------------------------------------------------- */

export const listPendingPayouts: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const rawLimit = Number(event.queryStringParameters?.limit ?? 50);
    const limit =
      !Number.isFinite(rawLimit) || rawLimit <= 0
        ? 50
        : Math.min(200, Math.floor(rawLimit));

  const rows = await withPgClient(async (client: any) => {
      const sql = `
        SELECT id, route_id, driver_id, parcels_delivered, planned_distance_km, actual_distance_km,
               variance_pct, rate_per_parcel, total_payout, payout_status, finalized_at
        FROM driver_payouts
        WHERE payout_status IN ('ON_HOLD', 'REVIEW', 'PENDING')
           OR (variance_pct IS NOT NULL AND variance_pct <> 0)
        ORDER BY finalized_at DESC NULLS LAST
        LIMIT $1
      `;
      const res = await queryWithRetry(client, sql, [limit], PG_MAX_RETRIES);
      return res.rows ?? [];
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ count: rows.length, items: rows }),
    };
  } catch (err: any) {
    console.error('[Ops] listPendingPayouts error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to list pending payouts', details: err instanceof Error ? err.message : String(err) }) };
  }
};

export const approvePayout: APIGatewayProxyHandlerV2 = async (event) => {
  const payoutId = event.pathParameters?.payoutId;
  if (!payoutId) return { statusCode: 400, body: JSON.stringify({ error: 'payoutId required' }) };

  let body: any = {};
  try {
    if (event.body) body = JSON.parse(event.body);
  } catch {
    // ignore parse errors
  }

  const auditId = uuidv4();
  try {
  const result = await withPgClient(async (client: any) => {
      const sql = `
        UPDATE driver_payouts
        SET payout_status = 'APPROVED', updated_at = NOW()
        WHERE id = $1 AND payout_status <> 'APPROVED'
        RETURNING id, route_id, driver_id, total_payout, payout_status
      `;
      const res = await queryWithRetry(client, sql, [payoutId], PG_MAX_RETRIES);

      if (res.rowCount === 0) {
        const getSql = `SELECT id, route_id, driver_id, total_payout, payout_status FROM driver_payouts WHERE id = $1`;
        const r2 = await queryWithRetry(client, getSql, [payoutId], PG_MAX_RETRIES);
        return { existing: r2.rows?.[0] ?? null, updated: null };
      }
      return { existing: null, updated: res.rows[0] };
    });

    if (result.updated) {
      await writeAudit({
        auditId,
        routePayoutId: payoutId,
        eventType: 'PAYOUT_APPROVED',
        details: { note: body.note ?? null, approver: body.approver ?? null, updated: result.updated },
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, updated: result.updated }) };
    }

    await writeAudit({
      auditId,
      routePayoutId: payoutId,
      eventType: 'PAYOUT_APPROVE_NOOP',
      details: { note: body.note ?? null, approver: body.approver ?? null, existing: result.existing },
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, note: 'noop', existing: result.existing }) };
  } catch (err: any) {
    console.error('[Ops] approvePayout error:', err);
    await writeAudit({
      auditId,
      routePayoutId: payoutId,
      eventType: 'PAYOUT_APPROVE_FAILED',
      details: { error: String(err) },
    });
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to approve payout', details: err instanceof Error ? err.message : String(err) }) };
  }
};

export const topupPayout: APIGatewayProxyHandlerV2 = async (event) => {
  const payoutId = event.pathParameters?.payoutId;
  if (!payoutId) return { statusCode: 400, body: JSON.stringify({ error: 'payoutId required' }) };

  if (!event.body) return { statusCode: 400, body: JSON.stringify({ error: 'Body required' }) };
  let body: any;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const topupAmount = Number(body.topupAmount);
  if (!Number.isFinite(topupAmount) || topupAmount <= 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'topupAmount must be a positive number' }) };
  }

  const idempotencyKey = (body.idempotencyKey as string) || `TOPUP#${uuidv4()}`;
  const note = body.note ?? null;
  const approver = body.approver ?? null;
  const auditId = uuidv4();

  try {
  const { updated, topupId, duplicate } = await withPgTransaction(async (client: any) => {
      const insertTopupSql = `
        INSERT INTO payout_topups (id, payout_id, topup_amount, idempotency_key, note, approver, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id
      `;
      const newTopupId = uuidv4();
      const r1 = await queryWithRetry(client, insertTopupSql, [
        newTopupId,
        payoutId,
        topupAmount,
        idempotencyKey,
        note,
        approver,
      ], PG_MAX_RETRIES);

      if (r1.rowCount === 0) {
        return { updated: null, topupId: null, duplicate: true };
      }

      const updateSql = `
        UPDATE driver_payouts
        SET total_payout = total_payout + $1,
            payout_status = 'APPROVED',
            updated_at = NOW()
        WHERE id = $2
        RETURNING id, total_payout, payout_status
      `;
      const r2 = await queryWithRetry(client, updateSql, [topupAmount, payoutId], PG_MAX_RETRIES);
      if (r2.rowCount === 0) throw new Error('Payout not found');

      return { updated: r2.rows[0], topupId: r1.rows[0].id, duplicate: false };
    });

    if (duplicate) {
      await writeAudit({
        auditId,
        routePayoutId: payoutId,
        eventType: 'PAYOUT_TOPUP_NOOP',
        details: { idempotencyKey },
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, note: 'duplicate_topup', idempotencyKey }) };
    }

    await writeAudit({
      auditId,
      routePayoutId: payoutId,
      eventType: 'PAYOUT_TOPUP_APPLIED',
      details: { topupId, topupAmount, idempotencyKey, note, approver, updated },
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, updated }) };
  } catch (err: any) {
    console.error('[Ops] topupPayout error:', err);
    await writeAudit({
      auditId,
      routePayoutId: payoutId,
      eventType: 'PAYOUT_TOPUP_FAILED',
      details: { error: String(err) },
    });
    const message = err instanceof Error ? err.message : String(err);
    const statusCode = message === 'Payout not found' ? 404 : 500;
    return {
      statusCode,
      body: JSON.stringify({ error: statusCode === 404 ? 'Payout not found' : 'Failed to apply topup', details: message }),
    };
  }
};

/* Export convenience map */
export const handlerMap = {
  listPendingPayouts,
  approvePayout,
  topupPayout,
};