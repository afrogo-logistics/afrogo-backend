import { Pool, PoolClient, QueryResult } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const REGION = process.env.AWS_REGION || process.env.REGION || 'af-south-1';
const PG_SECRET_ARN = process.env.PG_SECRET_ARN || '';

const parsedRetries = parseInt(process.env.PG_MAX_RETRIES ?? '2', 10);
export const PG_MAX_RETRIES = Number.isFinite(parsedRetries) && parsedRetries >= 0 ? parsedRetries : 2;

const secrets = new SecretsManagerClient({ region: REGION });

let pool: Pool | null = null;

interface DbConfig {
  host: string;
  port?: number;
  dbname?: string;
  database?: string;
  username?: string;
  user?: string;
  password: string;
  ssl?: string | boolean;
  maxConnections?: number;
}

/**
 * Lazily create & cache a pg.Pool.
 */
async function getPgPool(): Promise<Pool> {
  if (pool) return pool;
  if (!PG_SECRET_ARN) throw new Error('PG_SECRET_ARN not configured');

  const sec = await secrets.send(new GetSecretValueCommand({ SecretId: PG_SECRET_ARN }));
  if (!sec.SecretString) throw new Error('Postgres secret empty');

  const cfg: DbConfig = JSON.parse(sec.SecretString);

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

  pool.on('error', (err: Error) => {
    console.error('[PG_POOL] idle client error', err);
  });

  console.log('[PG_POOL] initialized');
  return pool;
}

export async function getPool(): Promise<Pool> {
  return getPgPool();
}

/**
 * Borrow a client from the pool, run fn, then release.
 */
export async function withPgClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withPgClient(fn);
}

export async function query<T = unknown>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
  const p = await getPgPool();
  return p.query(text, params) as Promise<QueryResult<T>>;
}

/**
 * Run a query on a given client with simple exponential backoff retries.
 * Micro-optimisation: do not wait after the final failed attempt.
 */
export async function pgQueryWithRetry(
  client: PoolClient,
  sql: string,
  params: unknown[] = [],
  maxRetries: number = PG_MAX_RETRIES,
): Promise<QueryResult> {
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await client.query(sql, params);
    } catch (err) {
      lastErr = err as Error;
      console.warn(`[PG] query attempt ${attempt} failed:`, String(err));
      // Only sleep if we'll actually retry again
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
      }
    }
  }

  throw new Error(`Postgres query failed after ${maxRetries + 1} attempts: ${String(lastErr)}`);
}