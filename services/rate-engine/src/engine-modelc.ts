/**
 * AFROOGO RATE ENGINE - Model C Implementation
 *
 * Pure business logic for Model C:
 *  - Guardrails
 *  - Rate calculation
 *  - Quote generation
 *  - Variance evaluation
 *
 * No side-effects, no AWS SDK here. Fully testable.
 *
 * Version: MODEL_C_V1
 * Last Updated: 2025-12-01
 */

import {
  RateEngineConfig,
  RouteQuoteRequest,
  RouteQuoteResponse,
  GuardrailResult,
  VarianceEvaluation,
} from './domain';

/**
 * applyGuardrails
 *
 * Validate a route candidate against operational constraints.
 */
export function applyGuardrails(
  req: RouteQuoteRequest,
  cfg: RateEngineConfig,
): GuardrailResult {
  const { plannedDistanceKm, parcelCount } = req;

  if (!Number.isFinite(plannedDistanceKm) || !Number.isFinite(parcelCount)) {
    return {
      status: 'INVALID',
      reason: 'NON_NUMERIC_VALUES',
      details: { plannedDistanceKm, parcelCount },
    };
  }

  if (plannedDistanceKm <= 0 || parcelCount <= 0) {
    return {
      status: 'INVALID',
      reason: 'NON_POSITIVE_VALUES',
      details: { plannedDistanceKm, parcelCount },
    };
  }

  if (parcelCount < cfg.minStops) {
    return {
      status: 'LOW_DENSITY',
      reason: 'INSUFFICIENT_STOPS',
      details: { parcelCount, minStops: cfg.minStops },
    };
  }

  if (parcelCount > cfg.maxStops) {
    return {
      status: 'LOW_DENSITY',
      reason: 'EXCESSIVE_STOPS',
      details: { parcelCount, maxStops: cfg.maxStops },
    };
  }

  if (plannedDistanceKm > cfg.maxRouteKm) {
    return {
      status: 'TOO_FAR',
      reason: 'ROUTE_EXCEEDS_MAX_KM',
      details: { plannedDistanceKm, maxRouteKm: cfg.maxRouteKm },
    };
  }

  const kmPerStop = plannedDistanceKm / parcelCount;
  if (kmPerStop > cfg.maxKmPerStop) {
    return {
      status: 'LOW_DENSITY',
      reason: 'KM_PER_STOP_TOO_HIGH',
      details: {
        kmPerStop: Math.round(kmPerStop * 100) / 100,
        maxKmPerStop: cfg.maxKmPerStop,
      },
    };
  }

  return { status: 'ACCEPTED' };
}

/**
 * calculateModelCRate
 *
 * ratePerParcel = baseRate + kmFactor * plannedDistanceKm
 * then floor/cap to min/max rate per parcel and round to cents
 */
export function calculateModelCRate(
  plannedDistanceKm: number,
  cfg: RateEngineConfig,
): number {
  const calculated = cfg.baseRateZar + cfg.kmFactorZar * plannedDistanceKm;

  const floored = Math.max(calculated, cfg.minRatePerParcelZar);
  const capped = Math.min(floored, cfg.maxRatePerParcelZar);

  // Round to 2 decimal places
  return Math.round(capped * 100) / 100;
}

/**
 * quoteRoute
 *
 * Produce a RouteQuoteResponse using Model C and guardrails.
 */
export function quoteRoute(
  req: RouteQuoteRequest,
  cfg: RateEngineConfig,
): RouteQuoteResponse {
  const guardrail = applyGuardrails(req, cfg);
  const calculatedAt = new Date().toISOString();

  if (guardrail.status !== 'ACCEPTED') {
    return {
      status: 'REJECTED',
      modelVersion: cfg.modelVersion,
      currency: 'ZAR',
      ratePerParcel: 0,
      totalPayout: 0,
      guardrailStatus: guardrail.status,
      guardrailDetails: guardrail.details,
      calculatedAt,
      configSnapshot: {
        baseRateZar: cfg.baseRateZar,
        kmFactorZar: cfg.kmFactorZar,
      },
    };
  }

  const ratePerParcel = calculateModelCRate(req.plannedDistanceKm, cfg);
  const totalPayout = Math.round(ratePerParcel * req.parcelCount * 100) / 100;

  return {
    status: 'ACCEPTED',
    modelVersion: cfg.modelVersion,
    currency: 'ZAR',
    ratePerParcel,
    totalPayout,
    guardrailStatus: 'ACCEPTED',
    calculatedAt,
    configSnapshot: {
      baseRateZar: cfg.baseRateZar,
      kmFactorZar: cfg.kmFactorZar,
      minStops: cfg.minStops,
      maxStops: cfg.maxStops,
    },
  };
}

/**
 * evaluateVariance
 *
 * Compare planned vs actual distance and categorise variance.
 * variancePct = (actual - planned) / planned * 100
 *
 * Returns:
 *  - variancePct (number, may be negative)
 *  - status: 'OK' | 'WARN' | 'HARD'
 *  - recommendedAction
 */
export function evaluateVariance(
  plannedKm: number,
  actualKm: number,
  cfg: RateEngineConfig,
): VarianceEvaluation {
  if (!Number.isFinite(plannedKm) || !Number.isFinite(actualKm) || plannedKm <= 0) {
    return {
      variancePct: 0,
      status: 'OK',
      recommendedAction: 'AUTO_APPROVE',
    };
  }

  const variancePctRaw = ((actualKm - plannedKm) / plannedKm) * 100;
  // Round to 2 decimals
  const variancePct = Math.round(variancePctRaw * 100) / 100;

  if (variancePct <= cfg.varianceWarnPct) {
    return {
      variancePct,
      status: 'OK',
      recommendedAction: 'AUTO_APPROVE',
    };
  }

  if (variancePct <= cfg.varianceHardPct) {
    return {
      variancePct,
      status: 'WARN',
      recommendedAction: 'REQUEST_OPS_REVIEW',
    };
  }

  return {
    variancePct,
    status: 'HARD',
    recommendedAction: 'HOLD_FOR_MANUAL',
  };
}

/**
 * determineFinalPayoutStatus
 *
 * Maps variance evaluation to payout status used by finalize flow.
 */
export function determineFinalPayoutStatus(
  varianceEval: VarianceEvaluation,
): 'APPROVED' | 'ON_HOLD' | 'REJECTED' {
  switch (varianceEval.status) {
    case 'OK':
      return 'APPROVED';
    case 'WARN':
      return 'ON_HOLD';
    case 'HARD':
      return 'ON_HOLD';
    default:
      return 'ON_HOLD';
  }
}