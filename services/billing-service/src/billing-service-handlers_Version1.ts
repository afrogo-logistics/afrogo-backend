/**
 * BILLING SERVICE - Handlers (merchant_ledger wiring + reconciler)
 *
 * - Uses pooled Postgres client (pg-client.ts) helpers
 * - Upserts merchant_ledger (idempotent by invoice_id)
 * - Writes ledger BEFORE Dynamo invoice status update; failures return 5xx so external providers can retry
 *
 * Notes:
 * - Adjust merchant_ledger column names / Dynamo attribute names to match your schema.
 * - Provide PAYMENT_PROVIDER_SECRET_ARN and (optionally) PAYMENT_PROVIDER_POLL_SECRET_ARN in env.
 */

import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { v4 as uuidv4 } from 'uuid';
import { createHmac } from 'crypto';
import type { PoolClient } from 'pg';

import { withPgTransaction, queryWithRetry } from './pg-client';

const REGION = process.env.AWS_REGION || process.env.REGION || 'af-south-1';
const ddb = new DynamoDBClient({ region: REGION });
const secrets = new SecretsManagerClient({ region: REGION });

const INVOICES_TABLE = process.env.INVOICES_TABLE_NAME ?? 'Invoices';
const PAYMENT_PROVIDER_SECRET_ARN = process.env.PAYMENT_PROVIDER_SECRET_ARN ?? '';
const PAYMENT_PROVIDER_POLL_SECRET_ARN = process.env.PAYMENT_PROVIDER_POLL_SECRET_ARN ?? '';
const PG_MAX_RETRIES = Number(process.env.PG_MAX_RETRIES ?? '2');

type InvoiceStatus = 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED' | 'PARTIAL';

interface InvoiceRecord {
  invoiceId: string;
  merchantId: string;
  createdAt?: string;
  dueDate?: string;
  status: InvoiceStatus;
  currency: string;
  totalAmount: number;
  items?: any[];
  customerEmail?: string;
  customerName?: string;
  s3Key?: string;
  providerReference?: string;
  paymentAttempts?: number;
  metadata?: Record<string, any>;
}

interface PaymentEvent {
  invoiceId: string;
  providerStatus: string;
  providerReference?: string;
  amount: number;
  currency?: string;
}

function nowIso() {
  return new Date().toISOString();
}

function mapProviderStatusToInternal(statusRaw: string): InvoiceStatus {
  const s = String(statusRaw || '').toLowerCase();
  if (['success', 'paid', 'completed'].includes(s)) return 'PAID';
  if (['failed', 'error'].includes(s)) return 'FAILED';
  if (s === 'partial') return 'PARTIAL';
  return 'PENDING';
}

/**
 * Load configured payment provider secret (used for webhook signature verification)
 */
async function getPaymentProviderSecrets(): Promise<Record<string, any> | null> {
  if (!PAYMENT_PROVIDER_SECRET_ARN) return null;
  try {
    const res = await secrets.send(new GetSecretValueCommand({ SecretId: PAYMENT_PROVIDER_SECRET_ARN }));
    if (!res.SecretString) return null;
    return JSON.parse(res.SecretString);
  } catch (err) {
    console.warn('[Billing] Failed to load payment provider secret:', String(err));
    return null;
  }
}

/**
 * Optional: load poll secrets to query provider API for reconciler
 */
async function getPaymentProviderPollSecrets(): Promise<Record<string, any> | null> {
  if (!PAYMENT_PROVIDER_POLL_SECRET_ARN) return null;
  try {
    const res = await secrets.send(new GetSecretValueCommand({ SecretId: PAYMENT_PROVIDER_POLL_SECRET_ARN }));
    if (!res.SecretString) return null;
    return JSON.parse(res.SecretString);
  } catch (err) {
    console.warn('[Billing] Failed to load payment provider poll secret:', String(err));
    return null;
  }
}

/**
 * Query payment provider for invoice status (reconciler). Replace details to match your provider.
 */
async function queryProviderForInvoiceStatus(
  invoice: InvoiceRecord,
  pollSecrets: Record<string, any> | null,
): Promise<{ providerStatus: string; providerReference?: string; amount?: number; currency?: string } | null> {
  if (!pollSecrets || !pollSecrets.apiBaseUrl || !pollSecrets.apiKey) {
    console.warn('[Billing] Poll secrets not configured; skipping provider call');
    return null;
  }

  const apiBaseUrl = pollSecrets.apiBaseUrl as string;
  const apiKey = pollSecrets.apiKey as string;
  const url = `${apiBaseUrl}/payments/status?invoiceId=${encodeURIComponent(invoice.invoiceId)}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    console.warn('[Billing] Provider status poll non-2xx', {
      invoiceId: invoice.invoiceId,
      status: res.status,
    });
    return null;
  }

  const data = (await res.json()) as any;
  return {
    providerStatus: data.status,
    providerReference: data.providerReference || data.providerRef || data.reference,
    amount: typeof data.amount === 'number' ? data.amount : undefined,
    currency: data.currency,
  };
}

/**
 * Upsert into merchant_ledger (idempotent keyed by invoice_id)
 * Adjust SQL column names to match your schema.
 */
async function upsertMerchantLedger(
  client: PoolClient,
  invoice: InvoiceRecord,
  payment: PaymentEvent,
) {
  const sql = `
    INSERT INTO merchant_ledger (
      id, invoice_id, merchant_id, amount, currency, type, provider_reference, paid_at, created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW()
    )
    ON CONFLICT (invoice_id) DO UPDATE SET
      amount = EXCLUDED.amount,
      currency = EXCLUDED.currency,
      provider_reference = EXCLUDED.provider_reference,
      paid_at = EXCLUDED.paid_at,
      updated_at = NOW()
    RETURNING id, invoice_id
  `;

  const id = uuidv4();
  const paidAt = payment.providerStatus ? nowIso() : nowIso();
  const params = [
    id,
    invoice.invoiceId,
    invoice.merchantId,
    payment.amount,
    payment.currency ?? invoice.currency ?? 'ZAR',
    'INVOICE_PAYMENT',
    payment.providerReference ?? null,
    paidAt,
  ];

  const res = await queryWithRetry(client, sql, params, PG_MAX_RETRIES);
  return res.rows?.[0] ?? null;
}

/**
 * Update invoice status in Dynamo (merge/update only)
 */
async function updateInvoiceStatusInDynamo(args: {
  invoiceId: string;
  newStatus: InvoiceStatus;
  providerReference?: string;
}) {
  const { invoiceId, newStatus, providerReference } = args;
  const updatedAt = nowIso();

  await ddb.send(
    new UpdateItemCommand({
      TableName: INVOICES_TABLE,
      Key: { PK: { S: invoiceId }, SK: { S: 'METADATA' } },
      UpdateExpression:
        'SET #status = :status, providerReference = :prov, paymentAttempts = if_not_exists(paymentAttempts, :zero) + :one, updatedAt = :updated',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': { S: newStatus },
        ':prov': { S: providerReference ?? '' },
        ':zero': { N: '0' },
        ':one': { N: '1' },
        ':updated': { S: updatedAt },
      },
    }),
  );
}

/* --------------------------
   Handlers
   -------------------------- */

/**
 * paymentWebhook
 *
 * Verifies signature (if configured), fetches invoice, and when status transitions to PAID
 * performs ledger upsert (Aurora) then updates Dynamo invoice status.
 *
 * Ledger write is performed BEFORE Dynamo update; failures return 5xx to allow safe retries.
 */
export const paymentWebhook: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) return { statusCode: 400, body: JSON.stringify({ error: 'Request body required' }) };

    const payload = JSON.parse(event.body);
    const invoiceId = payload.invoiceId;
    if (!invoiceId) return { statusCode: 400, body: JSON.stringify({ error: 'invoiceId required' }) };

    const secretsObj = await getPaymentProviderSecrets();
    const webhookSecret = secretsObj?.webhookSecret;

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

    // Build invoice record
    const invoice: InvoiceRecord = {
      invoiceId,
      merchantId: getRes.Item.merchantId?.S ?? 'UNKNOWN',
      createdAt: getRes.Item.createdAt?.S ?? nowIso(),
      dueDate: getRes.Item.dueDate?.S,
      status: (getRes.Item.status?.S as InvoiceStatus) ?? 'PENDING',
      currency: getRes.Item.currency?.S ?? 'ZAR',
      totalAmount: Number(getRes.Item.totalAmount?.N ?? '0'),
      items: JSON.parse(getRes.Item.items?.S || '[]'),
      customerEmail: getRes.Item.customerEmail?.S,
      customerName: getRes.Item.customerName?.S,
      s3Key: getRes.Item.s3Key?.S,
      providerReference: getRes.Item.providerReference?.S,
      paymentAttempts: Number(getRes.Item.paymentAttempts?.N ?? '0'),
      metadata: JSON.parse(getRes.Item.metadata?.S || '{}'),
    };

    const providerStatus = String(payload.status || '');
    const internalStatus = mapProviderStatusToInternal(providerStatus);
    const providerRef = payload.providerReference || payload.providerRef || payload.reference || invoice.providerReference || '';
    const amount = Number(payload.amount ?? invoice.totalAmount);
    const currency = payload.currency || invoice.currency;

    const paymentEvent: PaymentEvent = {
      invoiceId,
      providerStatus,
      providerReference: providerRef,
      amount,
      currency,
    };

  // Critical section: ledger + invoice update.
  await withPgTransaction(async (client: PoolClient) => {
      // Only write ledger when moving to PAID (or PARTIAL depending on business rules).
      if (internalStatus === 'PAID' || internalStatus === 'PARTIAL') {
        await upsertMerchantLedger(client, invoice, paymentEvent);
      }
      await updateInvoiceStatusInDynamo({
        invoiceId,
        newStatus: internalStatus,
        providerReference: providerRef,
      });
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err: any) {
    console.error('[Billing] paymentWebhook error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to process webhook', details: err instanceof Error ? err.message : String(err) }),
    };
  }
};

/**
 * reconcilePendingPayments
 *
 * Scans for PENDING invoices, polls provider for status, and when status moved to terminal states
 * performs the same ledger + invoice update flow as the webhook.
 */
export const reconcilePendingPayments: APIGatewayProxyHandlerV2 = async () => {
  try {
    const pollSecrets = await getPaymentProviderPollSecrets();

    const scanRes = await ddb.send(
      new ScanCommand({
        TableName: INVOICES_TABLE,
        FilterExpression: '#status = :pending',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':pending': { S: 'PENDING' } },
        Limit: 100,
      }),
    );

    const items = scanRes.Items ?? [];
    if (items.length === 0) {
      console.log('[Billing] reconcilePendingPayments: no pending invoices');
      return { statusCode: 200, body: JSON.stringify({ ok: true, pendingCount: 0 }) };
    }

    let updatedCount = 0;

    for (const item of items) {
      const invoiceId = item.PK?.S ?? item.invoiceId?.S;
      if (!invoiceId) continue;

      const invoice: InvoiceRecord = {
        invoiceId,
        merchantId: item.merchantId?.S || 'UNKNOWN',
        createdAt: item.createdAt?.S || nowIso(),
        dueDate: item.dueDate?.S,
        status: (item.status?.S as InvoiceStatus) || 'PENDING',
        currency: item.currency?.S || 'ZAR',
        totalAmount: Number(item.totalAmount?.N ?? '0'),
        items: JSON.parse(item.items?.S || '[]'),
        customerEmail: item.customerEmail?.S,
        customerName: item.customerName?.S,
        s3Key: item.s3Key?.S,
        providerReference: item.providerReference?.S,
        paymentAttempts: Number(item.paymentAttempts?.N ?? '0'),
        metadata: JSON.parse(item.metadata?.S || '{}'),
      };

      try {
        const providerInfo = await queryProviderForInvoiceStatus(invoice, pollSecrets);
        if (!providerInfo) continue;

        const internalStatus = mapProviderStatusToInternal(providerInfo.providerStatus);
        if (internalStatus === 'PENDING') continue;

        const paymentEvent: PaymentEvent = {
          invoiceId,
          providerStatus: providerInfo.providerStatus,
          providerReference: providerInfo.providerReference ?? invoice.providerReference,
          amount: providerInfo.amount ?? invoice.totalAmount,
          currency: providerInfo.currency ?? invoice.currency,
        };

  await withPgTransaction(async (client: PoolClient) => {
          if (internalStatus === 'PAID' || internalStatus === 'PARTIAL') {
            await upsertMerchantLedger(client, invoice, paymentEvent);
          }
          await updateInvoiceStatusInDynamo({
            invoiceId,
            newStatus: internalStatus,
            providerReference: paymentEvent.providerReference,
          });
        });

        updatedCount++;
      } catch (err) {
        console.error('[Billing] reconcilePendingPayments: failed for invoice', {
          invoiceId,
          err: String(err),
        });
        // continue processing other invoices
      }
    }

    console.log('[Billing] reconcilePendingPayments complete', { scanned: items.length, updatedCount });
    return { statusCode: 200, body: JSON.stringify({ ok: true, scanned: items.length, updatedCount }) };
  } catch (err: any) {
    console.error('[Billing] reconcilePendingPayments error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Reconcile failed', details: err instanceof Error ? err.message : String(err) }),
    };
  }
};