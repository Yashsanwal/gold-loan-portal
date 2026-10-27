import {
  bpsToPercent,
  gramsToMg,
  mgToGrams,
  paiseToRupees,
  quotePlan,
  valueGold,
  type QuoteRequest,
  type QuoteResponse,
} from "@goldloan/shared";
import type { LoanSchemeRow } from "../db/schema.js";
import type { GoldRateService } from "./gold-rate.js";
import type { SchemeService } from "./schemes.js";

/** Pure: same input, schemes and rate always give the same quote. */
export function buildQuote(
  input: QuoteRequest,
  schemes: LoanSchemeRow[],
  rate24kPaisePerGram: number,
  now: Date = new Date(),
): QuoteResponse {
  const netWeightMg = gramsToMg(input.netWeightGrams);
  const valuation = valueGold({ netWeightMg, karat: input.karat, rate24kPaisePerGram });

  return {
    netWeightGrams: input.netWeightGrams,
    grossWeightGrams: input.grossWeightGrams,
    karat: input.karat,
    rate24kPerGram: paiseToRupees(rate24kPaisePerGram),
    pureGoldGrams: mgToGrams(valuation.pureGoldMg),
    goldValue: paiseToRupees(valuation.goldValuePaise),
    goldValuePaise: valuation.goldValuePaise,
    quotes: schemes.map((scheme) => {
      const plan = quotePlan(valuation, scheme);
      return {
        planId: scheme.id,
        planName: scheme.name,
        repaymentType: scheme.repaymentType,
        annualInterestRatePercent: bpsToPercent(scheme.annualInterestRateBps),
        tenureMonths: scheme.tenureMonths,
        maxLtvPercent: bpsToPercent(scheme.maxLtvBps),
        appliedLtvPercent: bpsToPercent(plan.appliedLtvBps),
        eligibleLoan: plan.eligibleLoanRupees,
      };
    }),
    calculatedAt: now.toISOString(),
  };
}

export class QuoteService {
  constructor(
    private readonly schemes: SchemeService,
    private readonly goldRate: GoldRateService,
  ) {}

  async quote(input: QuoteRequest): Promise<QuoteResponse> {
    const [schemes, rate] = await Promise.all([this.schemes.listActive(), this.goldRate.current()]);
    return buildQuote(input, schemes, rate.rate24kPaisePerGram);
  }
}
