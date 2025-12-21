// Bridge that re-exports the root shared pg-client implementation using ESM
// imports. This keeps service-local imports stable while avoiding runtime
// require() usage which interferes with strict linting and TypeScript checks.
export * from '../../../lib/pg-client';

import * as _root from '../../../lib/pg-client';

export async function withPgClient<T>(cb: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  if (typeof _root.withPgClient === 'function') return _root.withPgClient(cb as any);
  if (typeof (_root as any).withPgTransaction === 'function') return ( (_root as any).withPgTransaction as any)(cb);
  // fallback: call cb with the exported root object
  return cb((_root as any) as import('pg').PoolClient);
}

export const withPgTransaction = ( (_root as any).withPgTransaction ?? _root.withPgClient) as typeof _root.withPgClient;
export const queryWithRetry = ( (_root as any).pgQueryWithRetry ?? (_root as any).queryWithRetry ?? (_root as any).queryWithBackoff) as any;
