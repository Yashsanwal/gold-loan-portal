import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSequence,
  pgTable,
  serial,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/*
 * Money is stored as integer paise (bigint), weights as integer milligrams,
 * rates as basis points. No floats anywhere in the database.
 */

export const repaymentTypeEnum = pgEnum("repayment_type", ["BULLET", "EMI"]);
export const leadStatusEnum = pgEnum("lead_status", [
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
]);
export const leadSourceEnum = pgEnum("lead_source", ["FORM", "AGENT"]);

export const applicationNumberSeq = pgSequence("application_number_seq", {
  startWith: 1001,
  increment: 1,
});

export const loanSchemes = pgTable(
  "loan_schemes",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    repaymentType: repaymentTypeEnum("repayment_type").notNull(),
    annualInterestRateBps: integer("annual_interest_rate_bps").notNull(),
    tenureMonths: integer("tenure_months").notNull(),
    maxLtvBps: integer("max_ltv_bps").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The 75% LTV ceiling is enforced by the database too, not only by code.
    check("loan_schemes_max_ltv_check", sql`${t.maxLtvBps} > 0 AND ${t.maxLtvBps} <= 7500`),
    check("loan_schemes_rate_check", sql`${t.annualInterestRateBps} >= 0`),
    check("loan_schemes_tenure_check", sql`${t.tenureMonths} > 0`),
  ],
);

export const leads = pgTable(
  "leads",
  {
    id: serial("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .unique()
      .default(sql`('GL-' || nextval('application_number_seq'))`),
    fullName: text("full_name").notNull(),
    mobileNumber: text("mobile_number").notNull(),
    grossWeightMg: integer("gross_weight_mg").notNull(),
    netWeightMg: integer("net_weight_mg").notNull(),
    karat: smallint("karat").notNull(),
    planId: text("plan_id")
      .notNull()
      .references(() => loanSchemes.id),
    rate24kPaisePerGram: bigint("rate_24k_paise_per_gram", { mode: "number" }).notNull(),
    pureGoldMg: integer("pure_gold_mg").notNull(),
    goldValuePaise: bigint("gold_value_paise", { mode: "number" }).notNull(),
    appliedLtvBps: integer("applied_ltv_bps").notNull(),
    eligibleLoanPaise: bigint("eligible_loan_paise", { mode: "number" }).notNull(),
    status: leadStatusEnum("status").notNull().default("SUBMITTED"),
    source: leadSourceEnum("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("leads_mobile_created_idx").on(t.mobileNumber, t.createdAt.desc()),
    index("leads_created_idx").on(t.createdAt.desc()),
    index("leads_plan_idx").on(t.planId),
    check("leads_weights_check", sql`${t.netWeightMg} > 0 AND ${t.netWeightMg} <= ${t.grossWeightMg} AND ${t.grossWeightMg} <= 1000000`),
    check("leads_karat_check", sql`${t.karat} IN (18, 22, 24)`),
    check("leads_ltv_check", sql`${t.appliedLtvBps} > 0 AND ${t.appliedLtvBps} <= 7500`),
    check("leads_mobile_check", sql`${t.mobileNumber} ~ '^[6-9][0-9]{9}$'`),
  ],
);

export const leadAuditLog = pgTable(
  "lead_audit_log",
  {
    id: serial("id").primaryKey(),
    leadId: integer("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    fromStatus: leadStatusEnum("from_status"),
    toStatus: leadStatusEnum("to_status").notNull(),
    note: text("note"),
    actor: text("actor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("lead_audit_lead_idx").on(t.leadId, t.createdAt)],
);

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  requestHash: text("request_hash").notNull(),
  responseStatus: integer("response_status").notNull(),
  responseBody: jsonb("response_body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type LeadRow = typeof leads.$inferSelect;
export type LoanSchemeRow = typeof loanSchemes.$inferSelect;
