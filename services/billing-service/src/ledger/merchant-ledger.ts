// The canonical implementation of ledger normalization/upsert lives in a small
// CommonJS helper (`../ledger.cjs`) which the tests exercise. To avoid
// duplication and ensure tests and production share the same logic, re-export
// the functions from that module while keeping TypeScript types here.
import type { PgTxClient, InvoiceRecord } from '@afrogo/shared-types';
// Import the CommonJS helper using an ES default import (Node will interop).
// This keeps the typed surface here while reusing the canonical JS helper.
import ledgerCjs from '../ledger.cjs';
import { queryWithRetry } from '../../lib/pg-client';

export function normalizeMoney(amount: number | string): number {
  // Delegate to the JS helper's param building and extract amount
  const params = ledgerCjs.buildLedgerParams({ invoiceId: 'i', merchantId: 'm' }, { amount });
  return params.amount;
}

// We keep a typed upsert that delegates to the query layer for actual DB work.
export async function upsertMerchantLedger(client: PgTxClient, invoice: InvoiceRecord, payment: { amount: number | string; currency?: string; providerReference?: string; lastEventDbId?: number | string; lastEventTime?: string; lastEventSeq?: number }) {
  // Delegate normalization to the shared JS helper
  const params = ledgerCjs.buildLedgerParams(invoice as any, { amount: payment.amount, currency: payment.currency, providerReference: payment.providerReference, lastEventDbId: payment.lastEventDbId, lastEventTime: payment.lastEventTime, lastEventSeq: payment.lastEventSeq });
  // Delegate DB upsert to existing pg-client.queryWithRetry via SQL here
  const sql = `
    INSERT INTO merchant_ledger (id, invoice_id, merchant_id, amount, currency, type, provider_reference, paid_at, created_at, last_event_time, last_event_db_id, last_event_seq, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
    ON CONFLICT (invoice_id) DO UPDATE SET
      amount = EXCLUDED.amount,
      currency = EXCLUDED.currency,
      provider_reference = EXCLUDED.provider_reference,
      paid_at = EXCLUDED.paid_at,
      updated_at = NOW(),
      last_event_time = EXCLUDED.last_event_time,
      last_event_db_id = EXCLUDED.last_event_db_id,
      last_event_seq = EXCLUDED.last_event_seq
    WHERE (
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
    'INVOICE_PAYMENT',
    params.providerReference,
    params.paidAt,
    params.createdAt,
    params.lastEventTime,
    params.lastEventDbId,
    params.lastEventSeq,
  ];
  const res = await queryWithRetry(client, sql, paramsArr, 2);
  return res.rows?.[0] ?? null;
}
