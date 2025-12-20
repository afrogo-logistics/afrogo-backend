import assert from 'assert';
import { normalizeMoney } from '../dist/money.js';

// 0.005 should round up to 0.01
assert.strictEqual(normalizeMoney(0.005), 0.01, '0.005 should round to 0.01');
// 0.0049 should round to 0.00
assert.strictEqual(normalizeMoney(0.0049), 0.0, '0.0049 should round to 0.00');

console.log('rounding.edge: PASS');
process.exit(0);
