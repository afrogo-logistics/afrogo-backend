// Lightweight bridge so handlers importing './pg-client' resolve to the lib adapter
export * from '../lib/pg-client';
export { getPgClient, upsertMerchantLedger } from '../lib/pg-client';
// Re-export the production upsert so callers can import from a single API if desired
export { upsertMerchantLedger as upsertMerchantLedgerTyped } from './ledger/merchant-ledger';

// Default export for legacy imports
import * as RootPg from '../lib/pg-client';
export default RootPg as any;
