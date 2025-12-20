/**
 * AFROOGO RATE ENGINE - Domain Model & Types
 * 
 * This file is the CONTRACT between all services. 
 * Change nothing here without coordinating with Routing, Driver App, Finance. 
 * 
 * Status: IMMUTABLE (until versioning required)
 * Version: MODEL_C_V1
 * Last Updated: 2025-11-30
 */

// ============================================================================
// CONFIGURATION TYPES
// ============================================================================

export interface RateEngineConfig {
  /** Base fixed rate per parcel (ZAR) */
  baseRateZar: number;

  /** Variable rate per km (ZAR/km) */
  kmFactorZar: number;

  /** Soft floor - if calculated rate drops below this, floor it */
  minRatePerParcelZar: number;

  /** Safety cap - if calculated rate exceeds this, cap it (prevents accidents) */
  maxRatePerParcelZar: number;

  /** Minimum parcels required in a route */
  minStops: number;

  /** Maximum parcels allowed in a route */
  maxStops: number;

  /** Maximum total distance for a route (km) */
  maxRouteKm: number;

  /** Maximum distance per individual stop (derived, but explicit for clarity) */
  maxKmPerStop: number;

  /** Variance threshold for warning (%) - ops review suggested */
  varianceWarnPct: number;

  /** Variance threshold for hard flag (%) - requires manual approval */
  varianceHardPct: number;

  /** Model identifier for versioning */
  modelVersion: string;

  /** Creation timestamp for audit */
  createdAt?: Date;
}

// ============================================================================
// REQUEST/RESPONSE TYPES
// ============================================================================

export interface RouteQuoteRequest {
  /** Unique route identifier (e.g., "ROUTE-2025-11-30-JHB001") */
  routeId: string;

  /** Total planned distance from AWS Location Service (km) */
  plannedDistanceKm: number;

  /** Number of stops/parcels with payout */
  parcelCount: number;

  /** Geographic zone (for context/audit) */
  zoneId?: string;

  /** Optional: driver context (for per-driver adjustments in future) */
  driverId?: string;

  /** Optional: service type (for future premium pricing) */
  serviceType?: 'AFROGO_DOOR' | 'AFROCOLLECT';
}

export type GuardrailStatus =
  | 'ACCEPTED'      // Route is viable
  | 'LOW_DENSITY'   // Too few stops, too many km per stop
  | 'TOO_FAR'       // Route exceeds max km
  | 'INVALID'       // Bad input (negative, zero, etc.)
  | 'INSUFFICIENT_CONFIG'; // Config not loaded

export interface GuardrailResult {
  status: GuardrailStatus;
  reason?: string; // E.g., 'TOO_FEW_STOPS', 'KM_PER_STOP_TOO_HIGH'
  details?: Record<string, unknown>; // Contextual data for debugging
}

export interface RouteQuoteResponse {
  status: 'ACCEPTED' | 'REJECTED';
  modelVersion: string;
  currency: 'ZAR';

  /** ZAR per parcel (if accepted) */
  ratePerParcel: number;

  /** Total payout across all parcels (ZAR) */
  totalPayout: number;

  /** Why was it accepted or rejected */
  guardrailStatus: GuardrailStatus;

  /** Additional context */
  guardrailDetails?: GuardrailResult['details'];

  /** Server timestamp */
  calculatedAt: string;

  /** Config snapshot for audit trail */
  configSnapshot?: Partial<RateEngineConfig>;
}

// ============================================================================
// VARIANCE & SETTLEMENT TYPES
// ============================================================================

export interface VarianceEvaluation {
  variancePct: number;
  status: 'OK' | 'WARN' | 'HARD'; // AUTO_APPROVE | OPS_REVIEW | MANUAL_DECISION
  recommendedAction: string; // "AUTO_APPROVE", "REQUEST_OPS_REVIEW", "HOLD_FOR_MANUAL"
}

export interface RouteActuals {
  /** Actual distance from GPS telemetry (km) */
  actualDistanceKm: number;

  /** Number of stops actually completed */
  completedStops: number;

  /** Timestamp when route was completed */
  completedAt: string;
}

/* Finalize request payload (client provides minimal actuals; server uses DB truth where needed) */
export interface RouteFinalizeRequest {
  routeId: string;
  driverId: string;
  plannedDistanceKm?: number; // optional, server will prefer DB value
  // actuals provided by the client at finalize time
  actualDistanceKm: number;
  parcelsDelivered: number;
  // optional snapshot fields included for visibility only (server will ignore for payout computation)
  ratePerParcel?: number;
  totalPayoutPlanned?: number;
}

/* Finalize response returned to callers */
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

// ============================================================================
// AUDIT & LEDGER TYPES
// ============================================================================

export interface PayoutAuditEntry {
  auditId: string; // UUID
  routeId: string;
  driverId: string;
  timestamp: string;
  eventType: 'QUOTE_CALCULATED' | 'PAYOUT_FINALIZED' | 'VARIANCE_FLAGGED' | 'TOPUP_APPLIED';
  modelVersion: string;
  config: Partial<RateEngineConfig>;
  request?: RouteQuoteRequest | RouteFinalizeRequest;
  response?: RouteQuoteResponse | RouteFinalizeResponse;
  metadata?: Record<string, unknown>;
}

export interface PayoutLedgerEntry {
  id: string; // UUID
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
  payoutStatus: 'PENDING' | 'APPROVED' | 'ON_HOLD' | 'REVIEW' | 'REJECTED';
  createdAt: string;
  updatedAt: string;
  finalizedAt?: string;
}

// ============================================================================
// ERROR TYPES
// ============================================================================

export class RateEngineError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
    message: string,
    public context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RateEngineError';
  }
}

export const ErrorCodes = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  CONFIG_LOAD_FAILED: 'CONFIG_LOAD_FAILED',
  GUARDRAIL_REJECTED: 'GUARDRAIL_REJECTED',
  CALCULATION_ERROR: 'CALCULATION_ERROR',
  AUDIT_WRITE_FAILED: 'AUDIT_WRITE_FAILED',
  DB_CONNECTION_FAILED: 'DB_CONNECTION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
} as const;