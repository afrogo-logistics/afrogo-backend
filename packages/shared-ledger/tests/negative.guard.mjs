import assert from 'assert';
import { normalizeMoney } from '../dist/money.js';

let threw = false;
try {
  normalizeMoney(-1);
} catch (err) {
  threw = true;
}

assert.strictEqual(threw, true, 'normalizeMoney should throw for negative amounts');
console.log('negative.guard: PASS');
process.exit(0);
