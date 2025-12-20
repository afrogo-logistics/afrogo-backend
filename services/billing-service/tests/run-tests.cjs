const { spawnSync } = require('child_process');
const tests = [
  'services/billing-service/tests/ledger.happy.cjs',
  'services/billing-service/tests/ledger.idempotency.cjs',
];

// Optionally run integration war-games if PG connection info is present or explicit flag set
if (process.env.RUN_WAR_GAMES === '1' || process.env.PGHOST) {
  tests.push('services/billing-service/tests/war-games.cjs');
}

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
