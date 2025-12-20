const { buildLedgerParams, applyLedgerUpsertMock } = require('../src/ledger');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function run() {
  const invoice = { invoiceId: 'inv-555', merchantId: 'm-77', currency: 'ZAR' };
  const payment = { amount: 50, currency: 'ZAR', providerReference: 'p-77' };

  const params1 = buildLedgerParams(invoice, payment);
  const db = new Map();
  const row1 = applyLedgerUpsertMock(db, params1);

  // Second call with same invoice and payment
  const params2 = buildLedgerParams(invoice, payment);
  const row2 = applyLedgerUpsertMock(db, params2);

  // After idempotent upsert, the ledger row for invoice should be updated but remain single
  assert(db.size === 1, 'expected single ledger row');
  const stored = db.get(invoice.invoiceId);
  assert(stored, 'row missing');
  // The amount should equal the payment amount
  assert(stored.amount === 50, 'amount mismatch after repeated upsert');
  console.log('ledger.idempotency: PASS');
}

try {
  run();
  process.exit(0);
} catch (err) {
  console.error('ledger.idempotency: FAIL', err && err.message);
  process.exit(1);
}
