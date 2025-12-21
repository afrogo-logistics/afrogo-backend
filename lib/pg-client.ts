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

export async function pgQueryWithRetry<T = unknown>(
  client: PoolClient,
  sql: string,
  params: unknown[] = [],
  maxRetries = 2,
): Promise<QueryResult<T>> {
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
  // The pg client typing expects `any[]` for values; narrow the usage to
  // this single call while keeping the outer API fully typed. We disable
  // the explicit-any rule for this line only to avoid broad linter
  // exceptions across the repo.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await client.query(sql, params as any)) as QueryResult<T>;
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

export async function query<T = unknown>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
  // The pool.query overloads accept `any[]` for values; narrow to a single
  // call site and locally disable the explicit-any warning.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return pool.query(text, params as any) as Promise<QueryResult<T>>;
}