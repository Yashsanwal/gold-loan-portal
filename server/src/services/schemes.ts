import { asc, eq } from "drizzle-orm";
import { bpsToPercent, type LoanScheme } from "@goldloan/shared";
import type { AppDb } from "../db/client.js";
import { loanSchemes, type LoanSchemeRow } from "../db/schema.js";

export function toLoanScheme(row: LoanSchemeRow): LoanScheme {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    repaymentType: row.repaymentType,
    annualInterestRatePercent: bpsToPercent(row.annualInterestRateBps),
    tenureMonths: row.tenureMonths,
    maxLtvPercent: bpsToPercent(row.maxLtvBps),
  };
}

export class SchemeService {
  constructor(private readonly db: AppDb) {}

  listActive(): Promise<LoanSchemeRow[]> {
    return this.db
      .select()
      .from(loanSchemes)
      .where(eq(loanSchemes.isActive, true))
      .orderBy(asc(loanSchemes.displayOrder), asc(loanSchemes.id));
  }

  async findActive(id: string): Promise<LoanSchemeRow | undefined> {
    const [row] = await this.db.select().from(loanSchemes).where(eq(loanSchemes.id, id)).limit(1);
    return row?.isActive ? row : undefined;
  }
}
