import { Pool, PoolClient, PoolConfig, QueryResult } from 'pg';
import debugLib from 'debug';

const debug = debugLib('ops:pg-client');

const poolConfig: PoolConfig = {
  connectionString: process.env.DATABASE_URL,
};

const pool = new Pool(poolConfig);

const parsedRetries = parseInt(process.env.PG_MAX_RETRIES ?? '2', 10);
export const PG_MAX_RETRIES = Number.isFinite(parsedRetries) && parsedRetries >= 0 ? parsedRetries : 2;

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// Alias for compatibility
export const withPgClient = withClient;
export const withPgTransaction = withClient;

export async function query<T = unknown>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
  debug('query', text, params?.length ?? 0);
  return pool.query(text, params) as Promise<QueryResult<T>>;
}

/**
 * Run a query on a given client with simple exponential backoff retries.
 */
export async function queryWithRetry(
  client: PoolClient,
  sql: string,
  params: unknown[] = [],
  maxRetries: number = PG_MAX_RETRIES,
): Promise<QueryResult> {
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      debug('queryWithRetry attempt', attempt, sql, params?.length ?? 0);
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

export default pool;
