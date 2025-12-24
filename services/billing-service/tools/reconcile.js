import { Client } from 'pg';

async function run() {
  const client = new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || 'postgres',
  });
  await client.connect();

  // Aggregate events per invoice
  const evRes = await client.query(`
    SELECT invoice_id, SUM(amount_cents) AS events_sum
    FROM merchant_payment_events
    GROUP BY invoice_id
  `);

  // Compare to ledger
  const mismatches = [];
  for (const row of evRes.rows) {
    const invoiceId = row.invoice_id;
    const eventsSum = Number(row.events_sum || 0);
    const led = await client.query('SELECT paid_total_cents FROM merchant_ledger WHERE invoice_id=$1 LIMIT 1', [invoiceId]);
    const paid = led.rows[0] ? Number(led.rows[0].paid_total_cents || 0) : 0;
    if (eventsSum !== paid) {
      mismatches.push({ invoiceId, eventsSum, paid });
    }
  }

  if (mismatches.length === 0) {
    console.log('Reconcile: no mismatches');
  } else {
    console.log('Reconcile: found mismatches', mismatches.slice(0, 20));
    // Optionally: write to a table or alerting system
  }

  await client.end();
}

run().catch((err) => {
  console.error('Reconcile failed', err && err.stack || err);
  process.exit(1);
});
