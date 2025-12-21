// CommonJS test helper. Prefer the workspace package `@afrogo/shared-ledger` at runtime
// if it's available (built); otherwise fall back to the in-file implementation.
let pkg = null;
try {
  // If the workspace package has been built, require it and use its builders.
  pkg = require('@afrogo/shared-ledger');
} catch (e) {
  // Not available yet — fall back to local implementation below.
}

if (pkg && pkg.buildLedgerParams && pkg.applyLedgerUpsertMock) {
  module.exports = { buildLedgerParams: pkg.buildLedgerParams, applyLedgerUpsertMock: pkg.applyLedgerUpsertMock };
} else {
  const toNumber = (val) => {
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      const n = Number(val);
      if (Number.isNaN(n)) throw new Error('Invalid number');
      return n;
    }
    throw new Error('Unsupported amount type');
  };

  const roundToCents = (n) => Math.round(n * 100) / 100;

  function buildLedgerParams(invoice, payment) {
    if (!invoice || !invoice.invoiceId) throw new Error('invoice.invoiceId required');
    if (!invoice.merchantId) throw new Error('invoice.merchantId required');
    const amountNum = roundToCents(toNumber(payment.amount));
    const currency = payment.currency || invoice.currency || 'ZAR';
    const id = `ledger-${invoice.invoiceId}`;
    const paidAt = new Date().toISOString();
    return {
      id,
      invoiceId: invoice.invoiceId,
      merchantId: invoice.merchantId,
      amount: amountNum,
      currency,
      type: 'INVOICE_PAYMENT',
      providerReference: payment.providerReference || null,
      lastEventDbId: payment.lastEventDbId || null,
      lastEventTime: payment.lastEventTime || null,
      lastEventSeq: payment.lastEventSeq || null,
      paidAt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function applyLedgerUpsertMock(dbMap, params) {
    const existing = dbMap.get(params.invoiceId);
    if (existing) {
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
}
