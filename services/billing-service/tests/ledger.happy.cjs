const { buildLedgerParams, applyLedgerUpsertMock } = require('../src/ledger.cjs');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function run() {
  const invoice = { invoiceId: 'inv-123', merchantId: 'm-1', currency: 'ZAR' };
  const payment = { amount: '123.45', currency: 'ZAR', providerReference: 'pay-1' };

  const params = buildLedgerParams(invoice, payment);
  const db = new Map();
  const row = applyLedgerUpsertMock(db, params);

  assert(row.invoiceId === invoice.invoiceId, 'invoiceId mismatch');
  assert(row.merchantId === invoice.merchantId, 'merchantId mismatch');
  assert(typeof row.amount === 'number', 'amount must be number');
  assert(row.amount === 123.45, `unexpected amount ${row.amount}`);
  console.log('ledger.happy: PASS');
}

try {
  run();
  process.exit(0);
} catch (err) {
  console.error('ledger.happy: FAIL', err && err.message);
  process.exit(1);
}
