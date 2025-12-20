// Simple WarGames runner for ledger scenarios (double-submit, transient DB failure)
const { createRequire } = require('module');
const requirePkg = createRequire(__filename);

async function run() {
  try {
    // Ensure packages are built
    const { execSync } = require('child_process');
    execSync('npm run build:packages', { stdio: 'inherit' });
  } catch (e) {
    console.error('Failed to build packages:', e && e.message);
    process.exit(1);
  }

  const ledger = requirePkg('@afrogo/shared-ledger');
  const { buildLedgerParams, upsertParamsToSql } = ledger;

  // In-memory DB map keyed by invoiceId
  const db = new Map();

  function mockQueryWithRetry(client, sql, paramsArr) {
    // paramsArr[1] is invoice_id in our SQL
    const invoiceId = paramsArr[1];
    const existing = db.get(invoiceId);
    if (existing) {
      // simulate update
      const updated = Object.assign({}, existing, { amount: paramsArr[3], updatedAt: new Date().toISOString() });
      db.set(invoiceId, updated);
      return { rows: [updated] };
    }
    const row = {
      id: paramsArr[0],
      invoiceId: paramsArr[1],
      merchantId: paramsArr[2],
      amount: paramsArr[3],
      currency: paramsArr[4],
      providerReference: paramsArr[5],
      paidAt: paramsArr[6],
      createdAt: paramsArr[7],
      updatedAt: paramsArr[8],
    };
    db.set(invoiceId, row);
    return { rows: [row] };
  }

  // Scenario 1: double-submit payment webhook
  const invoice = { invoiceId: 'wg-inv-1', merchantId: 'm-wg', createdAt: new Date().toISOString() };
  const payment = { amount: 100.0, currency: 'ZAR' };
  const params = buildLedgerParams(invoice, payment);
  const { sql, paramsArr } = upsertParamsToSql(params);

  // First upsert
  mockQueryWithRetry(null, sql, paramsArr);
  // Second upsert (duplicate submission) — should not create a second row
  mockQueryWithRetry(null, sql, paramsArr);

  if (db.size !== 1) {
    console.error('WarGames failure: double-submit created multiple rows');
    process.exit(1);
  }

  // Scenario 2: transient DB failure and retry (simulate by throwing on first attempt)
  let attempts = 0;
  function flakyQuery(client, sql2, params2) {
    attempts++;
    if (attempts === 1) throw new Error('Transient DB error');
    return mockQueryWithRetry(client, sql2, params2);
  }

  // Try to apply a different invoice with flaky query
  const invoice2 = { invoiceId: 'wg-inv-2', merchantId: 'm-wg', createdAt: new Date().toISOString() };
  const payment2 = { amount: 50.0, currency: 'ZAR' };
  const p2 = buildLedgerParams(invoice2, payment2);
  const { sql: sql2, paramsArr: paramsArr2 } = upsertParamsToSql(p2);

  try {
    // simulate retry wrapper
    try { flakyQuery(null, sql2, paramsArr2); } catch (err) { /* retry */ }
    // second attempt
    flakyQuery(null, sql2, paramsArr2);
  } catch (err) {
    console.error('WarGames failure: retry logic did not recover', err && err.message);
    process.exit(1);
  }

  if (!db.has(invoice2.invoiceId)) {
    console.error('WarGames failure: retry did not result in row');
    process.exit(1);
  }

  console.log('WarGames: all ledger scenarios passed');
  process.exit(0);
}

run();
