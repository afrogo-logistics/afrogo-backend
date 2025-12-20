import assert from 'assert';
import { buildLedgerParams, makeIdempotencyKey } from '../dist/merchant-ledger.js';

const invoice = { invoiceId: 'inv-999', merchantId: 'm-9', createdAt: new Date().toISOString() };
const payment = { amount: 10, currency: 'ZAR' };

const p1 = buildLedgerParams(invoice, payment);
const p2 = buildLedgerParams(invoice, payment);

assert.strictEqual(p1.idempotencyKey, p2.idempotencyKey, 'Idempotency keys must match for identical invoice/month');

// Different invoice => different key
const invoice2 = { ...invoice, invoiceId: 'inv-1000' };
const p3 = buildLedgerParams(invoice2, payment);
assert.notStrictEqual(p1.idempotencyKey, p3.idempotencyKey, 'Different invoices should have different idempotency keys');

// Sanity: makeIdempotencyKey direct usage
assert.strictEqual(makeIdempotencyKey(invoice.invoiceId, p1.month), p1.idempotencyKey, 'makeIdempotencyKey should match idempotencyKey field');

console.log('idempotency.key: PASS');
process.exit(0);
