import { createHash } from 'crypto';
import type { InvoiceRecord, PgTxClient } from '@afrogo/shared-types';
import { normalizeMoney } from './money.js';

export function makeIdempotencyKey(invoiceId: string, month?: string): string {
  const key = `${invoiceId}:${month ?? ''}`;
  return createHash('sha256').update(key).digest('hex');
}

export function buildLedgerParams(invoice: InvoiceRecord, payment: { amount: number | string; currency?: string; providerReference?: string; lastEventDbId?: number | string; lastEventTime?: string; lastEventSeq?: number }) {
  const amountNum = normalizeMoney(payment.amount);
  const currency = payment.currency || invoice.currency || 'ZAR';
  const now = new Date().toISOString();
  const month = invoice.createdAt ? new Date(String(invoice.createdAt)).toISOString().slice(0, 7) : new Date().toISOString().slice(0, 7);
  const id = `ledger-${invoice.invoiceId}`;

  return {
    id,
    invoiceId: invoice.invoiceId,
    merchantId: invoice.merchantId,
    month,
    amount: amountNum,
    currency,
    providerReference: payment.providerReference ?? null,
    paidAt: now,
    createdAt: now,
    updatedAt: now,
    lastEventTime: payment.lastEventTime ?? null,
    lastEventDbId: payment.lastEventDbId ?? null,
    lastEventSeq: payment.lastEventSeq ?? null,
    idempotencyKey: makeIdempotencyKey(invoice.invoiceId, month),
  } as const;
}

export function upsertParamsToSql(params: ReturnType<typeof buildLedgerParams>) {
  const sql = `
  INSERT INTO merchant_ledger (id, invoice_id, merchant_id, amount, currency, provider_reference, paid_at, created_at, last_event_time, last_event_db_id, last_event_seq, updated_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
    ON CONFLICT (invoice_id) DO UPDATE SET
      amount = EXCLUDED.amount,
      currency = EXCLUDED.currency,
      provider_reference = EXCLUDED.provider_reference,
      paid_at = EXCLUDED.paid_at,
      updated_at = NOW(),
      last_event_time = EXCLUDED.last_event_time,
      last_event_db_id = EXCLUDED.last_event_db_id
    WHERE (
      -- Only apply the update when the incoming event is newer or equal (and db id is newer/equal when times tie)
      EXCLUDED.last_event_time IS NOT NULL AND (
        merchant_ledger.last_event_time IS NULL OR
        EXCLUDED.last_event_time > merchant_ledger.last_event_time OR
        (
          EXCLUDED.last_event_time = merchant_ledger.last_event_time AND
          (
            merchant_ledger.last_event_seq IS NULL OR
            (EXCLUDED.last_event_seq IS NOT NULL AND EXCLUDED.last_event_seq >= merchant_ledger.last_event_seq)
          )
        )
      )
    )
    RETURNING id
  `;

  const paramsArr = [
    params.id,
    params.invoiceId,
    params.merchantId,
    params.amount,
    params.currency,
    params.providerReference,
    params.paidAt,
    params.createdAt,
    params.lastEventTime,
    params.lastEventDbId,
    params.lastEventSeq,
  ];

  return { sql, paramsArr } as const;
}

export async function upsertMerchantLedger(client: PgTxClient, invoice: InvoiceRecord, payment: { amount: number | string; currency?: string; providerReference?: string }, queryWithRetry: (client: PgTxClient, sql: string, params: any[], retries?: number) => Promise<any>) {
  const params = buildLedgerParams(invoice, payment);
  const { sql, paramsArr } = upsertParamsToSql(params);
  const res = await queryWithRetry(client, sql, paramsArr, 2);
  return res.rows?.[0] ?? null;
}
