/**
 * Exact gold-loan arithmetic.
 *
 * Every quantity is an integer while we compute:
 *   - weights are milligrams (inputs are validated to at most 3 decimals),
 *   - money is paise,
 *   - LTV is basis points (7500 = 75%).
 *
 * Products can exceed Number.MAX_SAFE_INTEGER (1,000,000 mg × 24 × 1,000,000 paise × 7,500 bps),
 * so the maths runs on BigInt and only converts back to Number once the result is small.
 *
 * pureGold  = net × karat / 24
 * goldValue = pureGold × rate24k
 * loan      = floor(goldValue × min(plan.maxLtv, 75%))   (whole rupees)
 *
 * The loan is floored from the *exact* gold value, never from a rounded one.
 */

export const KARATS = [18, 22, 24] as const;
export type Karat = (typeof KARATS)[number];

/** Regulatory ceiling: no plan may lend above 75% of the gold value. */
export const MAX_LTV_BPS = 7500;
export const MAX_WEIGHT_GRAMS = 1000;
export const WEIGHT_DECIMALS = 3;

const MG_PER_GRAM = 1000n;
const PAISE_PER_RUPEE = 100n;
const BPS_DENOMINATOR = 10_000n;
const KARAT_DENOMINATOR = 24n;

export interface PlanTerms {
  id: string;
  name: string;
  maxLtvBps: number;
}

export interface GoldValuation {
  netWeightMg: number;
  karat: Karat;
  rate24kPaisePerGram: number;
  /** Pure gold in milligrams, rounded half-up to the nearest mg (display only). */
  pureGoldMg: number;
  /** Gold value in paise, rounded half-up to the nearest paisa (display only). */
  goldValuePaise: number;
}

export interface PlanQuote {
  planId: string;
  planName: string;
  /** min(plan.maxLtvBps, MAX_LTV_BPS) */
  appliedLtvBps: number;
  /** Whole rupees, floored. */
  eligibleLoanRupees: number;
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer, got ${value}`);
  }
}

/** Round a non-negative rational n/d half-up to an integer. */
function divRoundHalfUp(n: bigint, d: bigint): bigint {
  return (n * 2n + d) / (2n * d);
}

function toSafeNumber(value: bigint, label: string): number {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new RangeError(`${label} overflowed the safe integer range`);
  }
  return asNumber;
}

/**
 * Converts a validated gram value (≤ 3 decimals) to integer milligrams.
 * Rounding absorbs binary float noise such as 45.123 * 1000 = 45122.99999999999.
 */
export function gramsToMg(grams: number): number {
  if (!Number.isFinite(grams) || grams < 0) {
    throw new RangeError(`grams must be a finite non-negative number, got ${grams}`);
  }
  return Math.round(grams * 1000);
}

/** True when the number has at most `WEIGHT_DECIMALS` decimal places. */
export function hasAtMostThreeDecimals(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const scaled = value * 1000;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

export function rupeesToPaise(rupees: number): number {
  if (!Number.isFinite(rupees) || rupees < 0) {
    throw new RangeError(`rupees must be a finite non-negative number, got ${rupees}`);
  }
  return Math.round(rupees * 100);
}

export function appliedLtvBps(planMaxLtvBps: number): number {
  assertSafeNonNegativeInteger(planMaxLtvBps, "planMaxLtvBps");
  return Math.min(planMaxLtvBps, MAX_LTV_BPS);
}

export function valueGold(input: {
  netWeightMg: number;
  karat: Karat;
  rate24kPaisePerGram: number;
}): GoldValuation {
  const { netWeightMg, karat, rate24kPaisePerGram } = input;
  assertSafeNonNegativeInteger(netWeightMg, "netWeightMg");
  assertSafeNonNegativeInteger(rate24kPaisePerGram, "rate24kPaisePerGram");
  if (!KARATS.includes(karat)) throw new RangeError(`Unsupported karat ${karat}`);

  const net = BigInt(netWeightMg);
  const k = BigInt(karat);
  const rate = BigInt(rate24kPaisePerGram);

  return {
    netWeightMg,
    karat,
    rate24kPaisePerGram,
    pureGoldMg: toSafeNumber(divRoundHalfUp(net * k, KARAT_DENOMINATOR), "pureGoldMg"),
    goldValuePaise: toSafeNumber(
      divRoundHalfUp(net * k * rate, KARAT_DENOMINATOR * MG_PER_GRAM),
      "goldValuePaise",
    ),
  };
}

/** floor(net × karat/24 × rate × ltv) in whole rupees, computed exactly. */
export function eligibleLoanRupees(input: {
  netWeightMg: number;
  karat: Karat;
  rate24kPaisePerGram: number;
  planMaxLtvBps: number;
}): number {
  const ltv = BigInt(appliedLtvBps(input.planMaxLtvBps));
  assertSafeNonNegativeInteger(input.netWeightMg, "netWeightMg");
  assertSafeNonNegativeInteger(input.rate24kPaisePerGram, "rate24kPaisePerGram");

  const numerator =
    BigInt(input.netWeightMg) * BigInt(input.karat) * BigInt(input.rate24kPaisePerGram) * ltv;
  const denominator = KARAT_DENOMINATOR * MG_PER_GRAM * BPS_DENOMINATOR * PAISE_PER_RUPEE;
  return toSafeNumber(numerator / denominator, "eligibleLoanRupees");
}

export function quotePlan(
  valuation: Pick<GoldValuation, "netWeightMg" | "karat" | "rate24kPaisePerGram">,
  plan: PlanTerms,
): PlanQuote {
  return {
    planId: plan.id,
    planName: plan.name,
    appliedLtvBps: appliedLtvBps(plan.maxLtvBps),
    eligibleLoanRupees: eligibleLoanRupees({ ...valuation, planMaxLtvBps: plan.maxLtvBps }),
  };
}

/** 41250 mg -> 41.25 ; values are exact decimals with ≤ 3 places. */
export function mgToGrams(mg: number): number {
  return Number((mg / 1000).toFixed(3));
}

/** 28875000 paise -> 288750 ; 12345 paise -> 123.45 */
export function paiseToRupees(paise: number): number {
  return Number((paise / 100).toFixed(2));
}

export function bpsToPercent(bps: number): number {
  return Number((bps / 100).toFixed(2));
}
