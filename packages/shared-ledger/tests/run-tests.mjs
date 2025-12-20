import { execSync } from 'child_process';
import path from 'path';

// Ensure packages are built before running tests
try {
  execSync('npm run build:packages', { stdio: 'inherit' });
} catch (err) {
  console.error('Failed to build packages:', err && err.message);
  process.exit(1);
}

const tests = [
  'packages/shared-ledger/tests/rounding.edge.mjs',
  'packages/shared-ledger/tests/negative.guard.mjs',
  'packages/shared-ledger/tests/idempotency.key.mjs',
];

for (const t of tests) {
  console.log('Running', t);
  const full = path.resolve(t);
  try {
    execSync(`node ${full}`, { stdio: 'inherit' });
  } catch (err) {
    console.error('Test failed:', t);
    process.exit(1);
  }
}

console.log('shared-ledger tests all passed');
process.exit(0);
