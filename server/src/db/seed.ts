import { sql } from "drizzle-orm";
import type { AppDb } from "./client.js";
import { loanSchemes } from "./schema.js";

export const SEED_SCHEMES = [
  {
    id: "PLAN_BULLET_01",
    name: "Bullet Repayment",
    description: "Pay interest and principal together at maturity, after 12 months.",
    repaymentType: "BULLET" as const,
    annualInterestRateBps: 1200,
    tenureMonths: 12,
    maxLtvBps: 7000,
    displayOrder: 1,
  },
  {
    id: "PLAN_EMI_01",
    name: "Monthly EMI",
    description: "Repay in 12 equal monthly instalments of principal and interest.",
    repaymentType: "EMI" as const,
    annualInterestRateBps: 1050,
    tenureMonths: 12,
    maxLtvBps: 7500,
    displayOrder: 2,
  },
];

/** Idempotent: re-running updates the two plans in place and never duplicates them. */
export async function seed(db: AppDb): Promise<void> {
  await db
    .insert(loanSchemes)
    .values(SEED_SCHEMES)
    .onConflictDoUpdate({
      target: loanSchemes.id,
      set: {
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        repaymentType: sql`excluded.repayment_type`,
        annualInterestRateBps: sql`excluded.annual_interest_rate_bps`,
        tenureMonths: sql`excluded.tenure_months`,
        maxLtvBps: sql`excluded.max_ltv_bps`,
        displayOrder: sql`excluded.display_order`,
        isActive: sql`true`,
      },
    });
}
