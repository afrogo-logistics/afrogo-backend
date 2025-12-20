/**
 * BILLING SERVICE - Handlers (merchant_ledger wiring)
 *
 * - Adds idempotent merchant_ledger upsert when invoice moves to PAID
 * - Ledger write uses Aurora via pg-client.upsertMerchantLedger (ON CONFLICT upsert)
 * - Ledger write is performed BEFORE Dynamo invoice status update. If ledger write fails we return 5xx so the webhook sender can retry.
 * - If Dynamo update fails after successful ledger write we log and return 5xx; upsert is idempotent so retries are safe.
 *
 * Environment variables:
 *  - PG_SECRET_ARN (Secrets Manager ARN for Postgres) required for ledger writes
 *
 * Status: PRODUCTION READY (integration tests required)
 * Last Updated: 2025-12-01
 */

import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { v4 as uuidv4 } from 'uuid';
import { createHmac } from 'crypto';

import { getPgClient, upsertMerchantLedger } from '../lib/pg-client';

const REGION = process.env.AWS_REGION || process.env.REGION || 'af-south-1';
const ddb = new DynamoDBClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const ses = new SESClient({ region: REGION });
const secrets = new SecretsManagerClient({ region: REGION });

const INVOICES_TABLE = process.env.INVOICES_TABLE_NAME ?? 'Invoices';
const INVOICES_BUCKET = process.env.INVOICES_BUCKET ?? 'afroogo-invoices';
const SES_SOURCE_EMAIL = process.env.SES_SOURCE_EMAIL ?? 'billing@afroogo.com';
const PAYMENT_PROVIDER_SECRET_ARN = process.env.PAYMENT_PROVIDER_SECRET_ARN ?? '';
const PG_SECRET_ARN = process.env.PG_SECRET_ARN ?? '';
const PG_MAX_RETRIES = Number(process.env.PG_MAX_RETRIES ?? '2');

/* --------------------------
   Helpers & types (trimmed for brevity)
   -------------------------- */

type InvoiceStatus = 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED' | 'PARTIAL';

/* --------------------------
   Handlers
   -------------------------- */

/**
 * paymentWebhook
 * - Verifies signature (if configured), updates invoice metadata,
 * - When status transitions to PAID -> write idempotent ledger row to Aurora (merchant_ledger)
 *
 * Flow:
 * 1) Verify webhook signature (if configured)
 * 2) Fetch invoice from DynamoDB (ensure exists)
 * 3) Determine newStatus
 * 4) If newStatus === 'PAID':
 *      a) upsertMerchantLedger(...) to write idempotent ledger row (Aurora)
 *      b) update Dynamo invoice status -> PAID + providerReference + attempts
 *    Else:
 *      a) update Dynamo invoice status only
 *
 * Rationale:
 * - We write ledger first to ensure accounting record exists before marking invoice PAID in Dynamo.
 * - Upsert ensures idempotency if webhook is retried.
 */
export const paymentWebhook: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Request body required' }) };
    }

    const payload = JSON.parse(event.body);
    const invoiceId = payload.invoiceId;
    if (!invoiceId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'invoiceId required' }) };
    }

    // Load provider secrets (for signature verification)
    let secretsObj: Record<string, any> | null = null;
    if (PAYMENT_PROVIDER_SECRET_ARN) {
      try {
        const res = await secrets.send(new GetSecretValueCommand({ SecretId: PAYMENT_PROVIDER_SECRET_ARN }));
        if (res.SecretString) secretsObj = JSON.parse(res.SecretString);
      } catch (err) {
        console.warn('[Billing] Failed to load payment provider secret:', String(err));
      }
    }
    const webhookSecret = secretsObj?.webhookSecret;

    // Verify HMAC signature if present
    if (webhookSecret && payload.signature) {
      const hmac = createHmac('sha256', webhookSecret);
      const expected = hmac.update(JSON.stringify(payload.data ?? payload)).digest('hex');
      if (expected !== payload.signature) {
        console.warn('[Billing] Webhook signature mismatch', { invoiceId });
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid signature' }) };
      }
    }

    // Fetch invoice metadata from DynamoDB
    const getRes = await ddb.send(
      new GetItemCommand({
        TableName: INVOICES_TABLE,
        Key: { PK: { S: invoiceId }, SK: { S: 'METADATA' } },
      }),
    );

    if (!getRes.Item) {
      console.warn('[Billing] Webhook for unknown invoice', { invoiceId });
      return { statusCode: 404, body: JSON.stringify({ error: 'Invoice not found' }) };
    }

    // Derive new status from provider payload
    const providerStatus = String(payload.status || '').toLowerCase();
    let newStatus: InvoiceStatus = 'PENDING';
    if (['success', 'paid', 'completed'].includes(providerStatus)) newStatus = 'PAID';
    if (['failed', 'error'].includes(providerStatus)) newStatus = 'FAILED';
    if (providerStatus === 'partial') newStatus = 'PARTIAL';

    const providerRef = payload.providerReference || payload.providerRef || payload.reference || '';
    const prevAttempts = Number(getRes.Item.paymentAttempts?.N ?? '0');
    const attempts = prevAttempts + 1;
    const updatedAt = new Date().toISOString();

    // If moving to PAID, write idempotent ledger row first (Aurora)
    if (newStatus === 'PAID') {
      // Prepare ledger payload
      const merchantId = getRes.Item.merchantId?.S ?? 'UNKNOWN';
      const totalAmount = Number(getRes.Item.totalAmount?.N ?? '0');
      const currency = getRes.Item.currency?.S ?? 'ZAR';
      const paidAt = updatedAt;

      try {
        const pg = await getPgClient({ secretArn: PG_SECRET_ARN });
        await upsertMerchantLedger(pg, {
          invoiceId,
          merchantId,
          amount: totalAmount,
          currency,
          providerReference: providerRef,
          paidAt,
        }, PG_MAX_RETRIES);
      } catch (pgErr) {
        console.error('[Billing] Failed to upsert merchant_ledger; aborting DDB update to allow retry', { invoiceId, err: String(pgErr) });
        // Return 500 so provider/webhook will retry. Upsert is idempotent so retrying is safe.
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to persist ledger', details: String(pgErr) }) };
      }
    }

    // Update invoice status & metadata in DynamoDB (merge)
    try {
      // Use UpdateItem to avoid clobbering unrelated attributes
      await ddb.send(
        new UpdateItemCommand({
          TableName: INVOICES_TABLE,
          Key: { PK: { S: invoiceId }, SK: { S: 'METADATA' } },
          UpdateExpression: 'SET #status = :status, providerReference = :prov, paymentAttempts = :attempts, updatedAt = :updated',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': { S: newStatus },
            ':prov': { S: providerRef },
            ':attempts': { N: String(attempts) },
            ':updated': { S: updatedAt },
          },
        }),
      );
    } catch (ddbErr) {
      console.error('[Billing] Failed to update invoice in Dynamo after ledger write', { invoiceId, err: String(ddbErr) });
      // If we wrote ledger but failed to update Dynamo, return 500 so the webhook can retry the Dynamo update.
      // Upsert ledger is idempotent, so retries are safe.
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to update invoice', details: String(ddbErr) }) };
    }

    // Success
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err: any) {
    console.error('[Billing] paymentWebhook error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to process webhook', details: err instanceof Error ? err.message : String(err) }) };
  }
};