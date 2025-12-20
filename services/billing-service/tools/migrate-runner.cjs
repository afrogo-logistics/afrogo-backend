#!/usr/bin/env node
/*
 * Simple Postgres migration runner used by ops and CI to validate/apply SQL files
 * - Looks for SQL files in ../migrations
 * - Runs each file in alphabetical order
 * - Respects BEGIN/COMMIT inside migration files
 *
 * Usage:
 *   node tools/migrate-runner.cjs            # run migrations against env PG_* variables
 *   node tools/migrate-runner.cjs --dry-run  # print files that would be applied
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

function envOr(key, fallback) {
  return process.env[key] || fallback;
}

async function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error('Migrations directory not found:', MIGRATIONS_DIR);
    process.exit(2);
  }

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    console.log('No migration files found in', MIGRATIONS_DIR);
    return;
  }

  console.log('Found', files.length, 'migration files:');
  files.forEach((f) => console.log(' -', f));

  if (dryRun) {
    console.log('\nDry run enabled; not applying migrations.');
    return;
  }

  // Build connection config from environment
  const clientConfig = {};
  // Accept either full connection string or components
  if (process.env.PG_CONNECTION_STRING || process.env.DATABASE_URL) {
    clientConfig.connectionString = process.env.PG_CONNECTION_STRING || process.env.DATABASE_URL;
  } else {
    clientConfig.host = envOr('PGHOST', '127.0.0.1');
    clientConfig.port = Number(envOr('PGPORT', '5432'));
    clientConfig.user = envOr('PGUSER', 'postgres');
    clientConfig.password = envOr('PGPASSWORD', 'postgres');
    clientConfig.database = envOr('PGDATABASE', 'postgres');
  }

  const client = new Client(clientConfig);

  try {
    await client.connect();
  } catch (err) {
    console.error('Failed to connect to Postgres:', String(err));
    process.exit(3);
  }

  // Apply files sequentially
  for (const file of files) {
    const p = path.join(MIGRATIONS_DIR, file);
    console.log('\nApplying', file);
    const sql = fs.readFileSync(p, 'utf8');
    try {
      // Migration files may contain explicit BEGIN/COMMIT
      await client.query(sql);
      console.log('Applied', file);
    } catch (err) {
      console.error('Error applying', file, ':', String(err));
      console.error('Aborting further migrations.');
      await client.end().catch(() => {});
      process.exit(4);
    }
  }

  await client.end();
  console.log('\nAll migrations applied successfully.');
}

run().catch((err) => {
  console.error('Migration runner failed:', String(err));
  process.exit(5);
});
