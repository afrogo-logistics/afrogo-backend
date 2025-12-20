// Lightweight JS helper used by unit tests to validate ledger param building and idempotency.
// This file is intentionally plain CommonJS so tests can run without TypeScript tooling.

function toNumber(val) {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const n = Number(val);
    if (Number.isNaN(n)) throw new Error('Invalid number');
    return n;
  }
  throw new Error('Unsupported amount type');
}

function roundToCents(n) {
  return Math.round(n * 100) / 100;
}

function buildLedgerParams(invoice, payment) {
  if (!invoice || !invoice.invoiceId) throw new Error('invoice.invoiceId required');
  if (!invoice.merchantId) throw new Error('invoice.merchantId required');
  const amountNum = roundToCents(toNumber(payment.amount));
  const currency = payment.currency || invoice.currency || 'ZAR';
  // Deterministic id for test-friendly behavior (not used in production)
  const id = `ledger-${invoice.invoiceId}`;
  const paidAt = new Date().toISOString();

  const params = {
    id,
    invoiceId: invoice.invoiceId,
    merchantId: invoice.merchantId,
    amount: amountNum,
    currency,
    type: 'INVOICE_PAYMENT',
    providerReference: payment.providerReference || null,
    paidAt,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return params;
}

function applyLedgerUpsertMock(dbMap, params) {
  // dbMap: Map(invoiceId => row)
  const existing = dbMap.get(params.invoiceId);
  if (existing) {
    // simulate ON CONFLICT (invoice_id) DO UPDATE
    const updated = Object.assign({}, existing, {
      amount: params.amount,
      currency: params.currency,
      providerReference: params.providerReference,
      paidAt: params.paidAt,
      updatedAt: new Date().toISOString(),
    });
    dbMap.set(params.invoiceId, updated);
    return updated;
  }
  const row = {
    id: params.id,
    invoiceId: params.invoiceId,
    merchantId: params.merchantId,
    amount: params.amount,
    currency: params.currency,
    providerReference: params.providerReference,
    paidAt: params.paidAt,
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
  };
  dbMap.set(params.invoiceId, row);
  return row;
}

module.exports = { buildLedgerParams, applyLedgerUpsertMock };
