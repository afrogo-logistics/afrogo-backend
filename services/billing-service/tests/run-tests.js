const { spawnSync } = require('child_process');
const tests = [
  'services/billing-service/tests/ledger.happy.js',
  'services/billing-service/tests/ledger.idempotency.js',
];

let failed = 0;
for (const t of tests) {
  console.log('Running', t);
  const res = spawnSync(process.execPath, [t], { stdio: 'inherit' });
  if (res.status !== 0) failed++;
}

if (failed) {
  console.error(`${failed} test(s) failed`);
  process.exit(1);
}

console.log('All tests passed');
process.exit(0);
