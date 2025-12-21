// Lightweight bridge so imports of './pg-client' in ops-service resolve to the root lib pg-client.
export * from '../../../lib/pg-client';

import * as _root from '../../../lib/pg-client';
import { PoolClient } from 'pg';

export async function withPgClient<T>(cb: (client: PoolClient) => Promise<T>): Promise<T> {
  return _root.withPgClient(cb);
}

// Alias for compatibility
export const withPgTransaction = _root.withPgClient;
export const queryWithRetry = _root.pgQueryWithRetry;
export const pgQueryWithRetry = _root.pgQueryWithRetry;
