// Bridge that re-exports the root shared pg-client implementation using ESM
// imports. This keeps service-local imports stable while avoiding runtime
// require() usage which interferes with strict linting and TypeScript checks.
export * from '../../../lib/pg-client';

import {
  withPgClient as rootWithPgClient,
  withPgTransaction as rootWithPgTransaction,
  pgQueryWithRetry as rootPgQueryWithPgRetry,
  query as rootQuery,
} from '../../../lib/pg-client';

export async function withPgClient<T>(cb: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  // Prefer the root implementation when available
  if (typeof rootWithPgClient === 'function') return rootWithPgClient(cb);
  // Fallback to calling the provided callback directly
  // (rare case when the shared implementation is not available at runtime)
  // @ts-expect-error runtime fallback
  return cb((undefined as unknown) as import('pg').PoolClient);
}

export const withPgTransaction = (rootWithPgTransaction ?? rootWithPgClient) as typeof rootWithPgClient;
export const queryWithRetry = (rootPgQueryWithPgRetry ?? (rootQuery as unknown)) as unknown as typeof rootPgQueryWithPgRetry;
