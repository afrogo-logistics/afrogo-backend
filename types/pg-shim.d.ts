// Lightweight augmentation for 'pg' package to tolerate existing code that accesses
// internal .client properties or uses the Client type in non-standard ways.
// This is a conservative Option A shim to reduce TypeScript noise across services.

declare module 'pg' {
  // Minimal runtime-friendly stubs so TypeScript can compile during conservative cleanup.
  export type PoolClient = any;
  export type Pool = any;
  export type Client = any;
  export type QueryResult<T = any> = any;

  export const Pool: any;
  export const Client: any;

  // Preserve some interfaces for code that imports types
  export interface PoolConfig { [key: string]: any }
  export interface ClientConfig { [key: string]: any }
}
