/**
 * AFROOGO RATE ENGINE - Domain Types & Errors
 *
 * Shared types used by Model C implementation and Lambdas.
 *
 * Version: MODEL_C_V1
 * Last Updated: 2025-12-01
 */

export interface RateEngineConfig {
  baseRateZar: number;
  kmFactorZar: number;
  minRatePerParcelZar: number;
  maxRatePerParcelZar: number;
  minStops: number;
  maxStops: number;
  maxRouteKm: number;
  maxKmPerStop: number;
  varianceWarnPct: number;
  varianceHardPct: number;
  modelVersion: string;
  createdAt?: Date;
}

/* Quote request from Routing service */
export interface RouteQuoteRequest {
  routeId: string;
  plannedDistanceKm: number;
  parcelCount: number;
  zoneId?: string;
  driverId?: string;
  serviceType?: string;
}

/* Guardrail result */
export type GuardrailStatus =
  | 'ACCEPTED'
  | 'LOW_DENSITY'
  | 'TOO_FAR'
  | 'INVALID'
  | 'INSUFFICIENT_CONFIG';

export interface GuardrailResult {
  status: GuardrailStatus;
  reason?: string;
  details?: Record<string, unknown>;
}

/* Quote response returned by Rate Engine */
export interface RouteQuoteResponse {
  status: 'ACCEPTED' | 'REJECTED';
  modelVersion: string;
  currency: 'ZAR';
  ratePerParcel: number;
  totalPayout: number;
  guardrailStatus: GuardrailStatus;
  guardrailDetails?: Record<string, unknown> | null;
  calculatedAt: string;
  configSnapshot?: Partial<RateEngineConfig>;
}

/* Variance evaluation result for finalize flow */
export interface VarianceEvaluation {
  variancePct: number;
  status: 'OK' | 'WARN' | 'HARD';
  recommendedAction: 'AUTO_APPROVE' | 'REQUEST_OPS_REVIEW' | 'HOLD_FOR_MANUAL';
}

/* Finalize request payload */
export interface RouteFinalizeRequest {
  routeId: string;
  driverId: string;
  plannedDistanceKm?: number; // optional, but we will use DB value in finalize handler
  // actuals provided by client at finalize time
  actualDistanceKm: number;
  parcelsDelivered: number;
  // snapshot fields (not trusted from client, included for visibility only)
  ratePerParcel?: number;
  totalPayoutPlanned?: number;
}

/* Finalize response */
export interface RouteFinalizeResponse {
  auditId: string;
  payoutStatus: 'APPROVED' | 'ON_HOLD' | 'REJECTED';
  variancePct: number;
  varianceStatus: 'OK' | 'WARN' | 'HARD';
  finalPayoutAmount: number;
  totalPayout: number;
  topupRequired: boolean;
  topupAmount?: number;
  reason?: string;
}

/* Audit entry written to DynamoDB audit table */
export interface PayoutAuditEntry {
  auditId: string;
  routeId: string;
  driverId?: string;
  timestamp: string;
  eventType: 'QUOTE_CALCULATED' | 'PAYOUT_FINALIZED' | 'VARIANCE_FLAGGED' | 'TOPUP_APPLIED';
  modelVersion: string;
  config?: Partial<RateEngineConfig>;
  request?: RouteQuoteRequest | RouteFinalizeRequest;
  response?: RouteQuoteResponse | RouteFinalizeResponse;
  metadata?: Record<string, unknown>;
}

/* Ledger entry shape (for application layer before writing to Aurora) */
export interface PayoutLedgerEntry {
  id: string;
  driverId: string;
  routeId: string;
  payoutModel: string;
  parcelsDelivered: number;
  plannedDistanceKm: number;
  actualDistanceKm?: number;
  variancePct?: number;
  baseRatePerParcel: number;
  kmFactorPerKm: number;
  ratePerParcel: number;
  totalPayout: number;
  extraTopup?: number;
  payoutStatus: 'PENDING' | 'APPROVED' | 'ON_HOLD' | 'REVIEW' | 'REJECTED' | 'PAID';
  createdAt?: string;
  updatedAt?: string;
  finalizedAt?: string;
}

/* Domain error class for consistent error handling */
export class RateEngineError extends Error {
  public code: string;
  public statusCode: number;
  public context?: Record<string, unknown>;

  constructor(code: string, statusCode: number, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'RateEngineError';
    this.code = code;
    this.statusCode = statusCode;
    this.context = context;
    Error.captureStackTrace(this, this.constructor);
  }
}

/* Common error codes */
export const ErrorCodes = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  CONFIG_LOAD_FAILED: 'CONFIG_LOAD_FAILED',
  GUARDRAIL_REJECTED: 'GUARDRAIL_REJECTED',
  CALCULATION_ERROR: 'CALCULATION_ERROR',
  AUDIT_WRITE_FAILED: 'AUDIT_WRITE_FAILED',
  DB_CONNECTION_FAILED: 'DB_CONNECTION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
} as const;