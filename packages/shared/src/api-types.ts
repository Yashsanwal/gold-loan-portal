import type { FieldError, LeadStatus } from "./schemas.js";
import type { Karat } from "./money.js";

/** Response shapes shared by the API and the web client. */

export type RepaymentType = "BULLET" | "EMI";
export type LeadSource = "FORM" | "AGENT";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    fields: FieldError[];
    details?: Record<string, unknown>;
  };
}

export interface LoanScheme {
  id: string;
  name: string;
  description: string;
  repaymentType: RepaymentType;
  annualInterestRatePercent: number;
  tenureMonths: number;
  maxLtvPercent: number;
}

export interface PlanQuoteView {
  planId: string;
  planName: string;
  repaymentType: RepaymentType;
  annualInterestRatePercent: number;
  tenureMonths: number;
  maxLtvPercent: number;
  /** LTV actually applied: min(plan max LTV, 75%). */
  appliedLtvPercent: number;
  /** Whole rupees. */
  eligibleLoan: number;
}

export interface QuoteResponse {
  netWeightGrams: number;
  grossWeightGrams: number;
  karat: Karat;
  rate24kPerGram: number;
  pureGoldGrams: number;
  /** Rupees, rounded to the paisa. */
  goldValue: number;
  goldValuePaise: number;
  quotes: PlanQuoteView[];
  calculatedAt: string;
}

export interface LeadView {
  applicationId: string;
  fullName: string;
  /** Always masked, e.g. 9876XXXX10. */
  mobileNumber: string;
  grossWeightGrams: number;
  netWeightGrams: number;
  karat: Karat;
  planId: string;
  planName: string;
  pureGoldGrams: number;
  goldValue: number;
  eligibleLoan: number;
  appliedLtvPercent: number;
  rate24kPerGram: number;
  status: LeadStatus;
  source: LeadSource;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLeadResponse {
  applicationId: string;
  status: LeadStatus;
  createdAt: string;
  lead: LeadView;
}

export interface AuditEntry {
  id: number;
  fromStatus: LeadStatus | null;
  toStatus: LeadStatus;
  note: string | null;
  actor: string;
  createdAt: string;
}

export interface LeadDetailResponse {
  lead: LeadView;
  audit: AuditEntry[];
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface LeadListResponse {
  data: LeadView[];
  pagination: Pagination;
}

export interface GoldRateResponse {
  rate24kPerGram: number;
  currency: "INR";
  source: string;
  asOf: string;
  cachedUntil: string;
}

/* ---------- Agent ---------- */

export interface ConfirmationSummary {
  confirmationId: string;
  fullName: string;
  mobileNumber: string;
  grossWeightGrams: number;
  netWeightGrams: number;
  karat: Karat;
  planId: string;
  planName: string;
  pureGoldGrams: number;
  goldValue: number;
  eligibleLoan: number;
  appliedLtvPercent: number;
  annualInterestRatePercent: number;
  tenureMonths: number;
}

export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "tool_start"; id: string; name: string; label: string }
  | { type: "tool_end"; id: string; name: string; ok: boolean; summary: string }
  | { type: "confirmation_required"; confirmation: ConfirmationSummary }
  | { type: "message"; text: string }
  | { type: "error"; code: string; message: string }
  | { type: "done" };

export interface AgentChatResponse {
  sessionId: string;
  reply: string;
  events: AgentEvent[];
  confirmation: ConfirmationSummary | null;
}

export type AgentConfirmResponse =
  | { outcome: "SUBMITTED"; applicationId: string; createdAt: string; lead: LeadView }
  | { outcome: "CANCELLED" };

export interface AgentStatusResponse {
  available: boolean;
  provider: string;
  model: string | null;
  reason?: string;
}
