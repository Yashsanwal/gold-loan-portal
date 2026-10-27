import { describe, expect, it } from "vitest";
import {
  MAX_LTV_BPS,
  appliedLtvBps,
  eligibleLoanRupees,
  gramsToMg,
  hasAtMostThreeDecimals,
  mgToGrams,
  paiseToRupees,
  quotePlan,
  valueGold,
} from "@goldloan/shared";
import { buildQuote } from "../../src/services/quotes.js";
import { SEED_SCHEMES } from "../../src/db/seed.js";

const RATE_PAISE = 7000 * 100;
const EMI = { id: "PLAN_EMI_01", name: "Monthly EMI", maxLtvBps: 7500 };
const BULLET = { id: "PLAN_BULLET_01", name: "Bullet Repayment", maxLtvBps: 7000 };

function quote(netGrams: number, karat: 18 | 22 | 24, plan: typeof EMI) {
  const valuation = valueGold({ netWeightMg: gramsToMg(netGrams), karat, rate24kPaisePerGram: RATE_PAISE });
  return { valuation, plan: quotePlan(valuation, plan) };
}

describe("assignment test cases (₹7,000/g mock rate)", () => {
  it("#1 45 g · 22K · EMI → pure 41.25 g, value ₹2,88,750, loan ₹2,16,562", () => {
    const { valuation, plan } = quote(45, 22, EMI);
    expect(mgToGrams(valuation.pureGoldMg)).toBe(41.25);
    expect(paiseToRupees(valuation.goldValuePaise)).toBe(288750);
    // 288750 × 0.75 = 216562.5 → floored, never rounded up
    expect(plan.eligibleLoanRupees).toBe(216562);
  });

  it("#2 45 g · 22K · Bullet → value ₹2,88,750, loan ₹2,02,125 at 70% LTV", () => {
    const { valuation, plan } = quote(45, 22, BULLET);
    expect(paiseToRupees(valuation.goldValuePaise)).toBe(288750);
    expect(plan.appliedLtvBps).toBe(7000);
    expect(plan.eligibleLoanRupees).toBe(202125);
  });

  it("#3 10 g · 18K · EMI → pure 7.5 g, value ₹52,500, loan ₹39,375", () => {
    const { valuation, plan } = quote(10, 18, EMI);
    expect(mgToGrams(valuation.pureGoldMg)).toBe(7.5);
    expect(paiseToRupees(valuation.goldValuePaise)).toBe(52500);
    expect(plan.eligibleLoanRupees).toBe(39375);
  });

  it("buildQuote returns both seeded plans with the expected loans", () => {
    const schemes = SEED_SCHEMES.map((s) => ({ ...s, isActive: true, createdAt: new Date() }));
    const result = buildQuote({ netWeightGrams: 45, grossWeightGrams: 48, karat: 22 }, schemes, RATE_PAISE);
    expect(result.pureGoldGrams).toBe(41.25);
    expect(result.goldValue).toBe(288750);
    expect(result.goldValuePaise).toBe(28_875_000);
    expect(Object.fromEntries(result.quotes.map((q) => [q.planId, q.eligibleLoan]))).toEqual({
      PLAN_BULLET_01: 202125,
      PLAN_EMI_01: 216562,
    });
  });
});

describe("LTV ceiling", () => {
  it("never lends above 75%, even if a plan is misconfigured higher", () => {
    expect(appliedLtvBps(9000)).toBe(MAX_LTV_BPS);
    const { plan } = quote(45, 22, { id: "X", name: "Bad plan", maxLtvBps: 9000 });
    expect(plan.appliedLtvBps).toBe(7500);
    expect(plan.eligibleLoanRupees).toBe(216562);
  });

  it("uses the plan's own LTV when it is below the ceiling", () => {
    expect(appliedLtvBps(6000)).toBe(6000);
  });
});

describe("exactness", () => {
  it("24K gold is 100% pure", () => {
    const { valuation } = quote(10, 24, EMI);
    expect(valuation.pureGoldMg).toBe(10_000);
    expect(valuation.goldValuePaise).toBe(7_000_000);
  });

  it("floors the loan from the exact value, not from a rounded value", () => {
    // 1 mg of 22K: value = 0.001 × 22/24 × 7000 = ₹6.41666…; 75% = ₹4.8125 → ₹4
    expect(eligibleLoanRupees({ netWeightMg: 1, karat: 22, rate24kPaisePerGram: RATE_PAISE, planMaxLtvBps: 7500 })).toBe(4);
  });

  it("handles 3-decimal weights without float drift", () => {
    expect(gramsToMg(45.123)).toBe(45123); // 45.123 × 1000 = 45122.999… in floating point
    expect(gramsToMg(0.001)).toBe(1);
    const { valuation, plan } = quote(45.123, 22, EMI);
    // 45.123 × 22/24 = 41.36275 g → 41.363 g (half-up to the mg)
    expect(valuation.pureGoldMg).toBe(41363);
    // 41.36275 × 7000 = ₹2,89,539.25
    expect(valuation.goldValuePaise).toBe(28_953_925);
    // 289539.25 × 0.75 = 217154.4375 → 217154
    expect(plan.eligibleLoanRupees).toBe(217154);
  });

  it("rounds non-terminating values half-up to the paisa", () => {
    // 10 g × 22/24 × 7000 = ₹64,166.666… → ₹64,166.67
    const { valuation, plan } = quote(10, 22, EMI);
    expect(valuation.goldValuePaise).toBe(6_416_667);
    expect(valuation.pureGoldMg).toBe(9167);
    expect(plan.eligibleLoanRupees).toBe(48125);
  });

  it("stays exact at the maximum weight and a very high rate (BigInt range)", () => {
    const loan = eligibleLoanRupees({
      netWeightMg: 1_000_000,
      karat: 24,
      rate24kPaisePerGram: 99_999_999, // ₹9,99,999.99 per gram
      planMaxLtvBps: 7500,
    });
    // 1000 × 999999.99 × 0.75 = 749,999,992.5 → 749,999,992
    expect(loan).toBe(749_999_992);
  });

  it("rejects non-integer internal inputs instead of silently rounding", () => {
    expect(() => valueGold({ netWeightMg: 1.5, karat: 22, rate24kPaisePerGram: RATE_PAISE })).toThrow(RangeError);
    expect(() => gramsToMg(Number.NaN)).toThrow(RangeError);
  });
});

describe("hasAtMostThreeDecimals", () => {
  it.each([
    [45, true],
    [45.1, true],
    [45.123, true],
    [0.001, true],
    [45.1234, false],
    [Number.POSITIVE_INFINITY, false],
  ])("%s → %s", (value, expected) => {
    expect(hasAtMostThreeDecimals(value)).toBe(expected);
  });
});
