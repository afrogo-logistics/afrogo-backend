import { Pool, PoolClient, PoolConfig, QueryResult } from 'pg';

const poolConfig: PoolConfig = {
  connectionString: process.env.DATABASE_URL,
};

const pool = new Pool(poolConfig);

export async function getPool(): Promise<Pool> {
  return pool;
}

export async function withPgClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    try {
      client.release();
    } catch (releaseErr) {
      console.warn('[PG_POOL] client.release() failed:', String(releaseErr));
    }
  }
}

export async function pgQueryWithRetry<T = any>(
  client: PoolClient,
  sql: string,
  params: unknown[] = [],
  maxRetries = 2,
): Promise<QueryResult<T>> {
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await client.query(sql, params as any) as QueryResult<T>;
    } catch (err) {
      lastErr = err;
      console.warn(`[PG] query attempt ${attempt} failed:`, String(err));
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
      }
    }
  }

  throw new Error(`Postgres query failed after ${maxRetries + 1} attempts: ${String(lastErr)}`);
}

export async function query<T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
  return pool.query(text, params as any) as Promise<QueryResult<T>>;
}