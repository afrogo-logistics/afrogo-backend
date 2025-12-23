#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';

const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
const resourceArn = process.env.DB_RESOURCE_ARN;
const secretArn = process.env.DB_SECRET_ARN;
const database = process.env.DB_NAME || 'afrogo';
const dryRun = process.argv.includes('--dry-run');

const migrationsDir =
  process.env.MIGRATIONS_DIR ||
  path.join(process.cwd(), 'services', 'billing-service', 'migrations');

if (!region || !resourceArn || !secretArn) {
  console.error('Missing env. Need AWS_REGION, DB_RESOURCE_ARN, DB_SECRET_ARN (and optionally DB_NAME).');
  process.exit(1);
}

function splitSql(sql) {
  const withoutLineComments = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  return withoutLineComments
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

const client = new RDSDataClient({ region });

async function execStmt(sql) {
  const cmd = new ExecuteStatementCommand({ resourceArn, secretArn, database, sql });
  return client.send(cmd);
}

async function ensureMigrationsTable() {
  await execStmt(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

async function fetchAppliedFilenames() {
  const res = await execStmt('SELECT filename FROM schema_migrations');
  const rows = res.records || [];
  return rows
    .map((r) => r?.[0]?.stringValue)
    .filter(Boolean);
}

function escapeLiteral(str) {
  return str.replace(/'/g, "''");
}

async function main() {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  if (!files.length) {
    console.error(`No .sql files found in ${migrationsDir}`);
    process.exit(1);
  }

  console.log(`Region: ${region}`);
  console.log(`DB: ${database}`);
  console.log(`Migrations dir: ${migrationsDir}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'APPLY'}`);
  console.log('');

  let applied = new Set();
  if (!dryRun) {
    await ensureMigrationsTable();
    applied = new Set(await fetchAppliedFilenames());
  }

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`==> ${file} (skipped; already applied)`);
      console.log('');
      continue;
    }

    const full = path.join(migrationsDir, file);
    const raw = fs.readFileSync(full, 'utf8');
    const stmts = splitSql(raw);

    console.log(`==> ${file} (${stmts.length} statements)`);

    for (let i = 0; i < stmts.length; i++) {
      const sql = stmts[i];
      const label = `   [${i + 1}/${stmts.length}]`;

      if (dryRun) {
        console.log(`${label} ${sql.slice(0, 120)}${sql.length > 120 ? '...' : ''}`);
        continue;
      }

      try {
        await execStmt(sql);
        console.log(`${label} OK`);
      } catch (e) {
        console.error(`${label} FAILED\nSQL:\n${sql}\n`);
        throw e;
      }
    }

    if (!dryRun) {
      const escaped = escapeLiteral(file);
      await execStmt(`INSERT INTO schema_migrations (filename) VALUES ('${escaped}') ON CONFLICT DO NOTHING`);
    }
    console.log('');
  }

  console.log('✅ All migrations processed');
}

main().catch((e) => {
  console.error('❌ Migration run failed:', e?.message || e);
  process.exit(1);
});
