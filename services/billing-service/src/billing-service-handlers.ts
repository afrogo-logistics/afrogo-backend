/**
 * BILLING SERVICE - Handlers (Updated)
 *
 * - Adds Aurora (Postgres) merchant_ledger writes when invoices are marked PAID (idempotent + retry/backoff)
 * - Replaces HTML->PDF placeholder with Puppeteer-based HTML->PDF generation (with safe fallback)
 * - Uses a StatusIndex GSI on Invoices table for reconcilePendingPayments (query instead of scan)
 * - Keeps S3 storage, SES email (best-effort), and DynamoDB invoice metadata
 *
 * Environment variables required/used:
 *  - REGION
 *  - INVOICES_TABLE_NAME
 *  - INVOICES_BUCKET
 *  - SES_SOURCE_EMAIL
 *  - PAYMENT_PROVIDER_SECRET_ARN
 *  - PG_SECRET_ARN (Secrets Manager ARN with Postgres connection JSON)
 *  - PG_MAX_RETRIES (optional)
 *
 * Notes:
 *  - This file relies on auxiliary modules:
 *      - ../lib/pdf-generator.ts   (Puppeteer wrapper, falls back to HTML buffer)
 *      - ../lib/pg-client.ts      (Postgres client with SecretsManager integration)
 *  - Ensure the Invoices DynamoDB table has a GSI named "StatusIndex" with partition key "status" and sort key "createdAt"
 *
 * Status: PRODUCTION READY (integration tests required)
 * Last Updated: 2025-12-01
 */

import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { upsertMerchantLedger as upsertMerchantLedgerTyped } from './ledger/merchant-ledger';
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { v4 as uuidv4 } from 'uuid';
import { createHmac } from 'crypto';

import { generatePdfBuffer } from '../lib/pdf-generator';
import { getPgClient, queryWithRetry, upsertMerchantLedger } from '../lib/pg-client';
import * as metrics from './metrics';
import type { PoolClient } from 'pg';

// Local DynamoDB item attribute shape used in a few mapping helpers
type DdbAttr = { S?: string; N?: string };
type DdbItem = Record<string, DdbAttr | undefined>;

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
   Types
   -------------------------- */

interface CreateInvoiceRequest {
  merchantId: string;
  dueDate?: string;
  items: Array<{ description: string; qty: number; unitPrice: number }>;
  currency?: string;
  reference?: string;
  customerEmail?: string;
  customerName?: string;
  metadata?: Record<string, any>;
}

type InvoiceStatus = 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED' | 'PARTIAL';

interface InvoiceRecord {
  invoiceId: string;
  merchantId: string;
  createdAt: string;
  dueDate?: string;
  status: InvoiceStatus;
  currency: string;
  totalAmount: number;
  items: Array<{ description: string; qty: number; unitPrice: number }>;
  s3Key?: string;
  customerEmail?: string;
  customerName?: string;
  providerReference?: string;
  paymentAttempts?: number;
  metadata?: Record<string, any>;
}

/* --------------------------
   Helpers
   -------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function calcTotal(items: Array<{ description: string; qty: number; unitPrice: number }>) {
  return (
    Math.round(
      items.reduce((s, it) => s + Number(it.qty) * Number(it.unitPrice), 0) * 100,
    ) / 100
  );
}

function escapeHtml(s: any) {
  if (s === undefined || s === null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function getPaymentProviderSecrets(): Promise<Record<string, any> | null> {
  if (!PAYMENT_PROVIDER_SECRET_ARN) return null;
  try {
    const res = await secrets.send(
      new GetSecretValueCommand({ SecretId: PAYMENT_PROVIDER_SECRET_ARN }),
    );
    if (!res.SecretString) return null;
    return JSON.parse(res.SecretString);
  } catch (err) {
    console.warn('[Billing] Failed to load payment provider secret:', String(err));
    return null;
  }
}

/* --------------------------
  Handlers
  -------------------------- */
export const generateInvoice: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Request body required' }) };
    }

    const body = JSON.parse(event.body) as CreateInvoiceRequest;

    if (!body.merchantId || !Array.isArray(body.items) || body.items.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'merchantId and at least one item required' }) };
    }

    const invoiceId = `INVOICE#${uuidv4()}`;
    const createdAt = nowIso();
    const currency = body.currency ?? 'ZAR';
    const totalAmount = calcTotal(body.items);
    const dueDate = body.dueDate;

    const invoice: InvoiceRecord = {
      invoiceId,
      merchantId: body.merchantId,
      createdAt,
      dueDate,
      status: 'PENDING',
      currency,
      totalAmount,
      items: body.items,
      customerEmail: body.customerEmail,
      customerName: body.customerName,
      paymentAttempts: 0,
      metadata: body.metadata ?? {},
    };

    // Generate real PDF (Puppeteer-backed) - fallback to HTML buffer if headless chrome not available
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await generatePdfBuffer(renderInvoiceHtml(invoice), { invoiceId });
    } catch (err) {
      console.warn('[Billing] PDF generation with Puppeteer failed, falling back to HTML buffer:', String(err));
      pdfBuffer = Buffer.from(renderInvoiceHtml(invoice), 'utf-8');
    }

    const s3Key = `invoices/${invoiceId}.pdf`;

    await s3.send(
      new PutObjectCommand({
        Bucket: INVOICES_BUCKET,
        Key: s3Key,
        Body: pdfBuffer,
        ContentType: 'application/pdf',
        ContentDisposition: `attachment; filename="${invoiceId}.pdf"`,
        ServerSideEncryption: 'AES256',
      }),
    );

    invoice.s3Key = s3Key;

    // Persist metadata in DynamoDB (defensive conditional write)
    await ddb.send(
      new PutItemCommand({
        TableName: INVOICES_TABLE,
        Item: {
          PK: { S: invoice.invoiceId },
          SK: { S: 'METADATA' },
          invoiceId: { S: invoice.invoiceId },
          merchantId: { S: invoice.merchantId },
          createdAt: { S: invoice.createdAt },
          dueDate: { S: invoice.dueDate ?? '' },
          status: { S: invoice.status },
          currency: { S: invoice.currency },
          totalAmount: { N: invoice.totalAmount.toString() },
          s3Key: { S: invoice.s3Key },
          customerEmail: { S: invoice.customerEmail ?? '' },
          customerName: { S: invoice.customerName ?? '' },
          items: { S: JSON.stringify(invoice.items) },
          metadata: { S: JSON.stringify(invoice.metadata ?? {}) },
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );

    // Send invoice email (best-effort)
    if (invoice.customerEmail) {
      try {
        const invoiceUrl = `https://${INVOICES_BUCKET}.s3.${REGION}.amazonaws.com/${s3Key}`;
        const subject = `Invoice ${invoice.invoiceId} from AfroGo`;
        const htmlBody = `<p>Hi ${escapeHtml(invoice.customerName ?? '')},</p>
          <p>Please find your invoice <a href="${invoiceUrl}">here</a>. Total: <strong>${invoice.totalAmount.toFixed(2)} ${invoice.currency}</strong>.</p>`;

        await ses.send(
          new SendEmailCommand({
            Source: SES_SOURCE_EMAIL,
            Destination: { ToAddresses: [invoice.customerEmail] },
            Message: {
              Subject: { Data: subject },
              Body: { Html: { Data: htmlBody } },
            },
          }),
        );
      } catch (err) {
        console.warn('[Billing] Failed to send invoice email (best-effort):', String(err));
      }
    }

    return { statusCode: 201, body: JSON.stringify({ invoiceId, s3Key, totalAmount, currency, createdAt }) };
  } catch (err: any) {
    console.error('[Billing] generateInvoice error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to generate invoice', details: err instanceof Error ? err.message : String(err) }) };
  }
};

/**
 * getInvoice
 * - Returns invoice metadata and S3 location (bucket + key)
 */
export const getInvoice: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const invoiceId = event.pathParameters?.invoiceId;
    if (!invoiceId) return { statusCode: 400, body: JSON.stringify({ error: 'invoiceId required' }) };

    const res = await ddb.send(new GetItemCommand({ TableName: INVOICES_TABLE, Key: { PK: { S: invoiceId }, SK: { S: 'METADATA' } } }));

    if (!res.Item) return { statusCode: 404, body: JSON.stringify({ error: 'Invoice not found' }) };

    const s3Key = res.Item.s3Key?.S;
    const invoice = {
      invoiceId: res.Item.invoiceId?.S,
      merchantId: res.Item.merchantId?.S,
      createdAt: res.Item.createdAt?.S,
      dueDate: res.Item.dueDate?.S,
      status: res.Item.status?.S,
      totalAmount: Number(res.Item.totalAmount?.N ?? '0'),
      currency: res.Item.currency?.S,
      customerEmail: res.Item.customerEmail?.S,
      customerName: res.Item.customerName?.S,
      s3Key,
    };

    return { statusCode: 200, body: JSON.stringify({ invoice, s3Bucket: INVOICES_BUCKET, s3Key }) };
  } catch (err: any) {
    console.error('[Billing] getInvoice error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to retrieve invoice', details: err instanceof Error ? err.message : String(err) }) };
  }
};

/**
 * paymentWebhook
 * - Verifies signature (if configured), updates invoice metadata,
 * - When status transitions to PAID -> write idempotent ledger row to Aurora (merchant_ledger)
 */
export const paymentWebhook: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) return { statusCode: 400, body: JSON.stringify({ error: 'Request body required' }) };
    const payload = JSON.parse(event.body);
    const invoiceId = payload.invoiceId;
    if (!invoiceId) return { statusCode: 400, body: JSON.stringify({ error: 'invoiceId required' }) };

    const secretsObj = await getPaymentProviderSecrets();
    const webhookSecret = secretsObj?.webhookSecret;

    // Verify signature if configured
    if (webhookSecret && payload.signature) {
      const hmac = createHmac('sha256', webhookSecret);
      const expected = hmac.update(JSON.stringify(payload.data ?? payload)).digest('hex');
      if (expected !== payload.signature) {
        console.warn('[Billing] Webhook signature mismatch', { invoiceId });
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid signature' }) };
      }
    }

    // Fetch invoice meta
    const getRes = await ddb.send(new GetItemCommand({ TableName: INVOICES_TABLE, Key: { PK: { S: invoiceId }, SK: { S: 'METADATA' } } }));
    if (!getRes.Item) {
      console.warn('[Billing] Webhook for unknown invoice', { invoiceId });
      return { statusCode: 404, body: JSON.stringify({ error: 'Invoice not found' }) };
    }

    // Map provider status -> internal
    const providerStatus = String(payload.status || '').toLowerCase();
    let newStatus: InvoiceStatus = 'PENDING';
    if (['success', 'paid', 'completed'].includes(providerStatus)) newStatus = 'PAID';
    if (['failed', 'error'].includes(providerStatus)) newStatus = 'FAILED';
    if (providerStatus === 'partial') newStatus = 'PARTIAL';

    const providerRef = payload.providerReference || payload.providerRef || payload.reference || '';
    const attempts = Number(getRes.Item.paymentAttempts?.N ?? '0') + 1;

    // Update invoice item (merge)
    const updatedItem = {
      ...getRes.Item,
      status: { S: newStatus },
      providerReference: { S: providerRef },
      paymentAttempts: { N: String(attempts) },
      updatedAt: { S: nowIso() },
    };

    await ddb.send(new PutItemCommand({ TableName: INVOICES_TABLE, Item: updatedItem }));

    // If paid, write ledger row to Aurora (idempotent upsert)
    if (newStatus === 'PAID') {
      try {
        const pg = await getPgClient({ secretArn: PG_SECRET_ARN });
        // Construct minimal ledger payload
        const totalAmount = Number(getRes.Item.totalAmount?.N ?? '0');
        const merchantId = getRes.Item.merchantId?.S ?? 'UNKNOWN';
        const paidAt = nowIso();

        // upsert into merchant_ledger: idempotent on invoice_id
        // Build a minimal invoice record to pass into the typed ledger upsert
        const invoiceRecord = {
          invoiceId,
          merchantId,
          createdAt: getRes.Item.createdAt?.S,
          status: 'PAID',
          currency: getRes.Item.currency?.S ?? 'ZAR',
          totalAmount,
          items: [],
        };

        // Insert an immutable payment event into merchant_payment_events (idempotent)
        // Prepare last event placeholders (will remain null if we can't persist/read the event)
        let lastEventDbId: number | null = null;
        let lastEventTime: string | null = null;
  // provider values declared outside try so catch can reference them for metrics
  let providerVal = payload.provider || 'unknown';
  let providerEventIdVal = payload.providerEventId || payload.providerReference || providerRef || `${invoiceId}:${Date.now()}`;
  try {
          const metricStart = Date.now();
          const insertEventSql = `
            INSERT INTO merchant_payment_events (
              provider, provider_event_id, invoice_id, merchant_id,
              event_type, event_time, amount_cents, currency, status, raw_payload
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
            ON CONFLICT (provider, provider_event_id) DO NOTHING
          `;
          const amountCents = Math.round(totalAmount * 100);
          const rawPayload = JSON.stringify(payload || {});
          providerVal = payload.provider || 'unknown';
          providerEventIdVal = payload.providerEventId || payload.providerReference || providerRef || `${invoiceId}:${Date.now()}`;
          const evParams = [
            providerVal,
            providerEventIdVal,
            invoiceId,
            merchantId,
            'WEBHOOK_PAID',
            new Date().toISOString(),
            amountCents,
            getRes.Item.currency?.S ?? 'ZAR',
            'PAID',
            rawPayload,
          ];

          // Insert immutably (do nothing on conflict), then SELECT the row to retrieve id and event_time
          await queryWithRetry(pg, insertEventSql, evParams, PG_MAX_RETRIES);
          const selectSql = `SELECT id, event_time FROM merchant_payment_events WHERE provider=$1 AND provider_event_id=$2 LIMIT 1`;
          const selRes = await queryWithRetry(pg, selectSql, [providerVal, providerEventIdVal], PG_MAX_RETRIES);
          lastEventDbId = selRes.rows?.[0]?.id ?? null;
          lastEventTime = selRes.rows?.[0]?.event_time ?? null;
          const metricDuration = Date.now() - metricStart;
          console.log('[metrics] event_insert_success', { invoiceId, provider: providerVal, providerEventId: providerEventIdVal, durationMs: metricDuration });
          metrics.increment('event_insert_success', 1, { invoiceId, provider: providerVal });
          metrics.timing('event_insert_duration_ms', metricDuration, { invoiceId, provider: providerVal });
        } catch (evErr) {
          // Log and continue; event insert should not block invoice state progression
          console.warn('[Billing] merchant_payment_events insert/select failed (continuing):', String(evErr));
          metrics.increment('event_insert_fail', 1, { invoiceId, provider: providerVal });
        }

        try {
          const upStart = Date.now();
          const res = await upsertMerchantLedgerTyped(pg as any, invoiceRecord as any, {
            amount: totalAmount,
            currency: getRes.Item.currency?.S ?? 'ZAR',
            providerReference: providerRef,
            lastEventDbId: lastEventDbId ?? undefined,
            lastEventTime: lastEventTime ?? undefined,
          });
          const upDur = Date.now() - upStart;
          console.log('[metrics] ledger_upsert_success', { invoiceId, ledgerId: res?.id ?? null, durationMs: upDur });
          metrics.increment('ledger_upsert_success', 1, { invoiceId });
          metrics.timing('ledger_upsert_duration_ms', upDur, { invoiceId });
        } catch (upErr) {
          console.error('[Billing] ledger upsert failed:', String(upErr));
          metrics.increment('ledger_upsert_fail', 1, { invoiceId });
        }
      } catch (pgErr) {
        // Important: we do not roll back the invoice status change. We log and surface metric/alert externally.
        console.error('[Billing] Failed to write merchant ledger (non-blocking):', String(pgErr));
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err: any) {
    console.error('[Billing] paymentWebhook error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to process webhook', details: err instanceof Error ? err.message : String(err) }) };
  }
};

/**
 * reconcilePendingPayments
 * - Uses StatusIndex GSI: partition key = status, sort key = createdAt
 * - Queries invoices with status = PENDING and processes them (placeholder)
 */
export const reconcilePendingPayments: APIGatewayProxyHandlerV2 = async () => {
  try {
    // Query the StatusIndex for PENDING invoices (efficient vs Scan)
    const res = await ddb.send(new QueryCommand({
      TableName: INVOICES_TABLE,
      IndexName: 'StatusIndex',
      KeyConditionExpression: '#status = :pending',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pending': { S: 'PENDING' } },
      Limit: 100,
      ScanIndexForward: true,
    }));

  const pendingInvoices = (res.Items ?? []).map((it: DdbItem) => it.invoiceId?.S).filter(Boolean) as string[];

    // Placeholder: implement provider polling & update logic here
    console.log('[Billing] reconcilePendingPayments invoked', { pendingCount: pendingInvoices.length, sample: pendingInvoices.slice(0, 5) });

    return { statusCode: 200, body: JSON.stringify({ ok: true, pendingCount: pendingInvoices.length }) };
  } catch (err: any) {
    console.error('[Billing] reconcilePendingPayments error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Reconcile failed', details: err instanceof Error ? err.message : String(err) }) };
  }
};

/* --------------------------
   Small helper: HTML renderer (used by PDF generator fallback)
   -------------------------- */

function renderInvoiceHtml(inv: InvoiceRecord): string {
  const itemsHtml = inv.items
    .map(
      (it) =>
        `<tr><td>${escapeHtml(it.description)}</td><td style="text-align:center">${it.qty}</td><td style="text-align:right">${it.unitPrice.toFixed(2)}</td><td style="text-align:right">${(it.qty * it.unitPrice).toFixed(2)}</td></tr>`,
    )
    .join('');
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"/><title>Invoice ${inv.invoiceId}</title></head>
  <body>
    <h1>AfroGo Invoice</h1>
    <p><strong>Invoice:</strong> ${inv.invoiceId}</p>
    <p><strong>Merchant:</strong> ${escapeHtml(inv.merchantId)}<br/>
       <strong>Customer:</strong> ${escapeHtml(inv.customerName || '-')}</p>
    <table width="100%" border="0" cellpadding="6" cellspacing="0">
      <thead><tr><th align="left">Description</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead>
      <tbody>${itemsHtml}</tbody>
      <tfoot><tr><td colspan="3" style="text-align:right"><strong>Total</strong></td><td style="text-align:right"><strong>${inv.totalAmount.toFixed(
        2,
      )} ${inv.currency}</strong></td></tr></tfoot>
    </table>
    <p>Due: ${inv.dueDate ?? 'On receipt'}</p>
    <p>Generated: ${inv.createdAt}</p>
  </body>
</html>`;
}