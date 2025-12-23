const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

async function run() {
  // Read connection from env (same as migrate-runner expects)
  const client = new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || 'postgres',
  });

  await client.connect();

  // Ensure pgcrypto is available for gen_random_uuid in migrations
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  // Load migration SQL files to create tables (idempotent)
  const m1 = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001-create-merchant-payment-events.sql'), 'utf8');
  const m2 = fs.readFileSync(path.join(__dirname, '..', 'migrations', '002-create-merchant-ledger.sql'), 'utf8');
  const m3 = fs.readFileSync(path.join(__dirname, '..', 'migrations', '003-add-event-seq.sql'), 'utf8');
  const m4 = fs.readFileSync(path.join(__dirname, '..', 'migrations', '004-add-ledger-last-event-seq.sql'), 'utf8');

  // The migration files include BEGIN/COMMIT; execute them as-is
  // Apply base migrations + event_seq / ledger seq migrations so tests exercise the new deterministic tie-break
  await client.query(m1);
  await client.query(m2);
  await client.query(m3);
  await client.query(m4);

  // Ensure a clean slate between runs (compose reuses PG volume across runs)
  await client.query('TRUNCATE merchant_payment_events, merchant_ledger RESTART IDENTITY');

  // Helper to insert event immutably and return id + event_time
  async function insertEvent(provider, providerEventId, invoiceId, merchantId, amountCents, currency, rawPayload, eventTime) {
    const insertSql = `INSERT INTO merchant_payment_events (provider, provider_event_id, invoice_id, merchant_id, event_type, event_time, amount_cents, currency, status, raw_payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT (provider, provider_event_id) DO NOTHING`;
    await client.query(insertSql, [provider, providerEventId, invoiceId, merchantId, 'TEST', eventTime || new Date().toISOString(), amountCents, currency, 'PAID', JSON.stringify(rawPayload || {})]);
    const sel = await client.query('SELECT id, event_time, event_seq FROM merchant_payment_events WHERE provider=$1 AND provider_event_id=$2 LIMIT 1', [provider, providerEventId]);
    return sel.rows[0] || null;
  }

  // Helper to run the conditional upsert similar to shared-ledger
  async function upsertLedger(invoiceId, merchantId, amountCents, currency, providerReference, lastEventTime, lastEventDbId, lastEventSeq) {
    const sql = `
      INSERT INTO merchant_ledger (id, invoice_id, merchant_id, invoice_total_cents, paid_total_cents, currency, last_event_time, last_event_db_id, last_event_seq, paid_at, created_at, updated_at)
      VALUES (gen_random_uuid(), $1,$2,0,$3,$4,$5,$6,$7,now(),now(),now())
      ON CONFLICT (invoice_id) DO UPDATE SET
        paid_total_cents = EXCLUDED.paid_total_cents,
        currency = EXCLUDED.currency,
        last_event_time = EXCLUDED.last_event_time,
        last_event_db_id = EXCLUDED.last_event_db_id,
        last_event_seq = EXCLUDED.last_event_seq,
        updated_at = now()
      WHERE (
        EXCLUDED.last_event_time IS NOT NULL AND (
          merchant_ledger.last_event_time IS NULL OR
          EXCLUDED.last_event_time > merchant_ledger.last_event_time OR
          (EXCLUDED.last_event_time = merchant_ledger.last_event_time AND (merchant_ledger.last_event_seq IS NULL OR (EXCLUDED.last_event_seq IS NOT NULL AND EXCLUDED.last_event_seq >= merchant_ledger.last_event_seq)))
        )
      )
      RETURNING id, paid_total_cents, last_event_time, last_event_db_id, last_event_seq
    `;
    const res = await client.query(sql, [invoiceId, merchantId, amountCents, currency, lastEventTime, lastEventDbId, lastEventSeq]);
    return res.rows[0] || null;
  }

  // Scenario 1: Duplicate event => single event row, ledger correct
  console.log('WAR-GAMES: scenario 1 (duplicate event)');
  const invoiceId = 'inv-war-1';
  const provider = 'test-provider';
  const providerEventId = 'evt-dup-1';
  const merchantId = 'm-war-1';

  const e1 = await insertEvent(provider, providerEventId, invoiceId, merchantId, 1000, 'ZAR', { sample: true }, new Date().toISOString());
  const e2 = await insertEvent(provider, providerEventId, invoiceId, merchantId, 1000, 'ZAR', { sample: true }, new Date().toISOString());
  const selAll = await client.query('SELECT * FROM merchant_payment_events WHERE provider=$1 AND provider_event_id=$2', [provider, providerEventId]);
  assert(selAll.rows.length === 1, 'duplicate event created more than one row');

  // Upsert ledger based on event
  const up1 = await upsertLedger(invoiceId, merchantId, 1000, 'ZAR', 'ref-1', e1.event_time, e1.id);
  assert(up1 !== null, 'ledger upsert failed');

  // Scenario 2: Out-of-order events (older shouldn't overwrite newer)
  console.log('WAR-GAMES: scenario 2 (out-of-order)');
  const laterEvent = await insertEvent(provider, 'evt-later', invoiceId, merchantId, 2000, 'ZAR', {}, new Date(Date.now() + 10000).toISOString());
  // write ledger with later event
  const upLater = await upsertLedger(invoiceId, merchantId, 2000, 'ZAR', 'ref-late', laterEvent.event_time, laterEvent.id);
  assert(upLater !== null, 'later ledger upsert failed');

  // Now insert an older event and attempt upsert; should NOT downgrade
  const olderEvent = await insertEvent(provider, 'evt-older', invoiceId, merchantId, 500, 'ZAR', {}, new Date(Date.now() - 10000).toISOString());
  const upOlder = await upsertLedger(invoiceId, merchantId, 500, 'ZAR', 'ref-old', olderEvent.event_time, olderEvent.id);
  // upOlder may be null (no update applied) — fetch ledger to assert paid_total_cents is still 2000
  const ledger = await client.query('SELECT paid_total_cents, last_event_time FROM merchant_ledger WHERE invoice_id=$1', [invoiceId]);
  assert(Number(ledger.rows[0].paid_total_cents) === 2000, 'out-of-order event overwrote later payment');

  // Scenario 3: tie-break same timestamp uses db id ordering
  console.log('WAR-GAMES: scenario 3 (same timestamp tie-break)');
  const ts = new Date().toISOString();
  const a = await insertEvent(provider, 'evt-tie-a', 'inv-war-tie', 'm-war-2', 100, 'ZAR', {}, ts);
  const b = await insertEvent(provider, 'evt-tie-b', 'inv-war-tie', 'm-war-2', 200, 'ZAR', {}, ts);
  // Ensure they exist
  assert(a && b, 'tie events not created');
  console.log('WAR-GAMES-DEBUG: event a:', a);
  console.log('WAR-GAMES-DEBUG: event b:', b);
  // Upsert with a then with b; since times equal, DB id ordering will decide — because ids are UUIDs, we assert the second upsert which has >= id should apply
  const upA = await upsertLedger('inv-war-tie', 'm-war-2', 100, 'ZAR', 'a', a.event_time, a.id, a.event_seq);
  const upB = await upsertLedger('inv-war-tie', 'm-war-2', 200, 'ZAR', 'b', b.event_time, b.id, b.event_seq);
  const finalTie = await client.query('SELECT paid_total_cents, last_event_time, last_event_db_id, last_event_seq FROM merchant_ledger WHERE invoice_id=$1', ['inv-war-tie']);
  console.log('WAR-GAMES-DEBUG: final ledger row:', finalTie.rows[0]);
  // `paid_total_cents` is returned from pg as a string; coerce to Number for comparison
  assert(Number(finalTie.rows[0].paid_total_cents) === 200, 'tie-break did not result in expected winner');

  // Scenario 4: insert fail / retry recovery — simulate by attempting to upsert with null lastEventDbId then later passing correct id
  console.log('WAR-GAMES: scenario 4 (insert failure & retry)');
  const invRetry = 'inv-war-retry';
  // Simulate event fail: no row inserted (use random providerEventId and then do a ledger upsert with nulls)
  const badProviderEvent = 'evt-retry-bad';
  // no insert executed
  const upBad = await upsertLedger(invRetry, 'm-war-3', 3000, 'ZAR', 'ref-bad', null, null);
  // upBad may be null (no update), but ledger might now exist or not; ensure a later proper insert recovers
  const goodEvent = await insertEvent(provider, 'evt-retry-good', invRetry, 'm-war-3', 3000, 'ZAR', {}, new Date().toISOString());
  const upGood = await upsertLedger(invRetry, 'm-war-3', 3000, 'ZAR', 'ref-good', goodEvent.event_time, goodEvent.id);
  const ledgerRetry = await client.query('SELECT paid_total_cents FROM merchant_ledger WHERE invoice_id=$1', [invRetry]);
  assert(Number(ledgerRetry.rows[0].paid_total_cents) === 3000, 'retry recovery failed');

  console.log('WAR-GAMES: all scenarios passed');

  await client.end();
}

run().then(() => process.exit(0)).catch((err) => {
  console.error('WAR-GAMES: FAILED', err && err.stack || err);
  process.exit(1);
});
