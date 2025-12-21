// Lightweight bridge so imports of './pg-client' in ops-service resolve to the root lib pg-client.
export * from '../../../lib/pg-client';

// This file intentionally uses a runtime require to forward to the root lib
// implementation (avoids circular import issues). Allow var-requires for this
// line.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const _root: any = require('../../../lib/pg-client');

export async function withPgClient(cb: any) {
  if (typeof _root.withPgClient === 'function') return _root.withPgClient(cb);
  if (typeof _root.withPgTransaction === 'function') return _root.withPgTransaction(cb);
  // fallback: call cb with the exported root object
  return cb(_root);
}

export const withPgTransaction: any = _root.withPgTransaction || _root.withPgClient || _root.withPg;
export const queryWithRetry: any = _root.pgQueryWithRetry || _root.queryWithRetry || _root.queryWithBackoff;
