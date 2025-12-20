/**
 * PG CLIENT (POOL) - Shared helper for all services
 *
 * - Uses pg.Pool with Secrets Manager credentials
 * - Exposes withPgClient() to borrow/release a client
 * - Exposes pgQueryWithRetry() for resilient queries on a given client
 *
 * Env:
 *  - REGION / AWS_REGION
 *  - PG_SECRET_ARN
 *  - PG_MAX_RETRIES (optional, default 2)
 */

// @ts-ignore - AWS SDK v3 client types may be provided per-service; shimbed at build root
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
// Conservative typing for pg to avoid cross-service type mismatches during monorepo cleanup.
// We treat pool/client/query results as `any` here and will tighten types later.
import { Pool } from 'pg';

const REGION = process.env.AWS_REGION || process.env.REGION || 'af-south-1';
const PG_SECRET_ARN = process.env.PG_SECRET_ARN || '';

const parsedRetries = parseInt(process.env.PG_MAX_RETRIES ?? '2', 10);
export const PG_MAX_RETRIES = Number.isFinite(parsedRetries) && parsedRetries >= 0 ? parsedRetries : 2;

const secrets = new SecretsManagerClient({ region: REGION });

let pool: any = null;

/**
 * Lazily create & cache a pg.Pool.
 */
async function getPgPool(): Promise<any> {
  if (pool) return pool;
  if (!PG_SECRET_ARN) throw new Error('PG_SECRET_ARN not configured');

  const sec = await secrets.send(new GetSecretValueCommand({ SecretId: PG_SECRET_ARN }));
  if (!sec.SecretString) throw new Error('Postgres secret empty');

  const cfg = JSON.parse(sec.SecretString);

  pool = new Pool({
    host: cfg.host,
    port: cfg.port || 5432,
    database: cfg.dbname || cfg.database,
    user: cfg.username || cfg.user,
    password: cfg.password,
    ssl: cfg.ssl !== 'false' && cfg.ssl !== false,
    max: cfg.maxConnections || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on('error', (err: unknown) => {
    // err is unknown at runtime; log safely
    console.error('[PG_POOL] idle client error', err);
  });

  console.log('[PG_POOL] initialized');
  return pool;
}

/**
 * Borrow a client from the pool, run fn, then release.
 */
export async function withPgClient<T>(fn: (client: any) => Promise<T>): Promise<T> {
  const p = await getPgPool();
  const client = await p.connect();
  try {
    return await fn(client);
  } finally {
    // ensure we always release the client back to the pool
    try {
      client.release();
    } catch (releaseErr) {
      console.warn('[PG_POOL] client.release() failed:', String(releaseErr));
    }
  }
}

/**
 * Run a query on a given client with simple exponential backoff retries.
 * Micro-optimisation: do not wait after the final failed attempt.
 */
export async function pgQueryWithRetry(
  client: any,
  sql: string,
  params: any[] = [],
  maxRetries: number = PG_MAX_RETRIES,
): Promise<any> {
  let lastErr: any = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await client.query(sql, params);
    } catch (err) {
      lastErr = err;
      console.warn(`[PG] query attempt ${attempt} failed:`, String(err));
      // Only sleep if we'll actually retry again
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
      }
    }
  }

  throw new Error(`Postgres query failed after ${maxRetries + 1} attempts: ${String(lastErr)}`);
}