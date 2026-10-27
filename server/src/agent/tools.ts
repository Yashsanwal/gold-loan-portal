import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  formatDateIst,
  formatGrams,
  formatInr,
  leadRequestSchema,
  maskMobile,
  mobileNumberSchema,
  quoteRequestSchema,
  toFieldErrors,
  type ConfirmationSummary,
  type LeadRequest,
  type QuoteResponse,
} from "@goldloan/shared";
import type { Services } from "../services/index.js";
import { buildQuote } from "../services/quotes.js";
import { toLoanScheme } from "../services/schemes.js";
import type { AgentSession, PendingConfirmation } from "./session-store.js";
import type { ToolCall, ToolResult, ToolSpec } from "./types.js";

/* ---------------- JSON schemas, generated from the same Zod schemas the API uses ---------------- */

const FIELD_DESCRIPTIONS: Record<string, string> = {
  netWeightGrams: "Net gold weight in grams (gold only), > 0, ≤ gross weight, max 3 decimals",
  grossWeightGrams: "Gross jewellery weight in grams (incl. stones), > 0, ≤ 1000, max 3 decimals",
  karat: "Gold purity: 18, 22 or 24",
  fullName: "Applicant's full name: 2-60 letters and spaces",
  mobileNumber: "Applicant's 10-digit Indian mobile number starting with 6-9, digits only",
  planId: "Plan id exactly as returned by get_loan_schemes, e.g. PLAN_EMI_01",
};

function toToolSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  const properties = (json.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, property] of Object.entries(properties)) {
    // Unicode property escapes are not portable across providers; Zod still enforces them.
    if (typeof property.pattern === "string" && property.pattern.includes("\\p{")) delete property.pattern;
    if (FIELD_DESCRIPTIONS[key]) property.description = FIELD_DESCRIPTIONS[key];
  }
  return json;
}

const checkExistingSchema = z.object({ mobileNumber: mobileNumberSchema });

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "get_loan_schemes",
    description:
      "List the active gold-loan plans with interest rate, tenure and maximum LTV. The only valid source for plan information.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "calculate_quote",
    description:
      "Calculate pure gold, gold value and the eligible loan for every active plan (POST /quotes). The only valid source for any number you tell the user.",
    inputSchema: toToolSchema(quoteRequestSchema),
  },
  {
    name: "check_existing_application",
    description:
      "Check whether this mobile number already has an application in the last 7 days. Use it once you have the mobile number, before preparing an application.",
    inputSchema: toToolSchema(checkExistingSchema),
  },
  {
    name: "submit_application",
    description:
      "Prepare a gold-loan application for the user to confirm. Call only after the user said yes to your summary. This does NOT submit: it shows the user a confirmation card, and the application is filed only when they press Confirm.",
    inputSchema: toToolSchema(leadRequestSchema),
  },
];

export const TOOL_LABELS: Record<string, string> = {
  get_loan_schemes: "Fetching loan plans…",
  calculate_quote: "Calculating quote…",
  check_existing_application: "Checking existing applications…",
  submit_application: "Preparing your application…",
};

/* ---------------- Execution ---------------- */

export interface ToolContext {
  services: Services;
  session: AgentSession;
  onConfirmation(summary: ConfirmationSummary): void;
}

export interface ToolOutcome {
  ok: boolean;
  payload: Record<string, unknown>;
  /** One-line status for the UI chip. */
  summary: string;
}

function validationFailure(error: z.ZodError, hint: string): ToolOutcome {
  const fields = toFieldErrors(error);
  return {
    ok: false,
    payload: { ok: false, error: { code: "VALIDATION_ERROR", message: hint, fields } },
    summary: fields.map((f) => f.message).join("; "),
  };
}

function formatQuoteForModel(quote: QuoteResponse) {
  return {
    ok: true,
    karat: quote.karat,
    netWeightGrams: quote.netWeightGrams,
    grossWeightGrams: quote.grossWeightGrams,
    rate24kPerGram: quote.rate24kPerGram,
    rate24kPerGramFormatted: `${formatInr(quote.rate24kPerGram)}/g (24K)`,
    pureGoldGrams: quote.pureGoldGrams,
    pureGoldFormatted: formatGrams(quote.pureGoldGrams),
    goldValue: quote.goldValue,
    goldValueFormatted: formatInr(quote.goldValue),
    plans: quote.quotes.map((plan) => ({
      planId: plan.planId,
      planName: plan.planName,
      annualInterestRatePercent: plan.annualInterestRatePercent,
      tenureMonths: plan.tenureMonths,
      appliedLtvPercent: plan.appliedLtvPercent,
      eligibleLoan: plan.eligibleLoan,
      eligibleLoanFormatted: formatInr(plan.eligibleLoan),
    })),
    note: "Preliminary offer, subject to physical verification of the gold. Quote these figures exactly.",
  };
}

async function getLoanSchemes(ctx: ToolContext): Promise<ToolOutcome> {
  const schemes = (await ctx.services.schemes.listActive()).map(toLoanScheme);
  return {
    ok: true,
    payload: { ok: true, plans: schemes },
    summary: `${schemes.length} plans available`,
  };
}

async function calculateQuote(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const parsed = quoteRequestSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error, "Ask the user to correct these values.");
  const quote = await ctx.services.quotes.quote(parsed.data);
  const best = Math.max(...quote.quotes.map((q) => q.eligibleLoan));
  return {
    ok: true,
    payload: formatQuoteForModel(quote),
    summary: `Up to ${formatInr(best)} on ${formatGrams(quote.pureGoldGrams)} pure gold`,
  };
}

async function checkExisting(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const parsed = checkExistingSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error, "Ask the user for a valid mobile number.");
  const existing = await ctx.services.leads.findRecentApplication(parsed.data.mobileNumber);
  if (!existing) {
    return {
      ok: true,
      payload: { ok: true, exists: false, mobileNumber: maskMobile(parsed.data.mobileNumber) },
      summary: "No recent application",
    };
  }
  return {
    ok: true,
    payload: {
      ok: true,
      exists: true,
      mobileNumber: maskMobile(parsed.data.mobileNumber),
      applicationId: existing.applicationId,
      status: existing.status,
      submittedOn: formatDateIst(existing.createdAt),
      note: "Only one application per mobile number is allowed every 7 days.",
    },
    summary: `Existing application ${existing.applicationId}`,
  };
}

async function prepareApplication(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const parsed = leadRequestSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error, "Ask the user to correct these values.");
  const request: LeadRequest = parsed.data;

  const scheme = await ctx.services.schemes.findActive(request.planId);
  if (!scheme) {
    return {
      ok: false,
      payload: {
        ok: false,
        error: {
          code: "PLAN_NOT_FOUND",
          message: "Unknown planId. Call get_loan_schemes and use one of its ids.",
          fields: [{ field: "planId", message: "Unknown plan" }],
        },
      },
      summary: "Unknown plan",
    };
  }

  const existing = await ctx.services.leads.findRecentApplication(request.mobileNumber);
  if (existing) {
    return {
      ok: false,
      payload: {
        ok: false,
        error: {
          code: "DUPLICATE_APPLICATION",
          message: "This mobile already has an application in the last 7 days; a new one cannot be filed.",
          applicationId: existing.applicationId,
          submittedOn: formatDateIst(existing.createdAt),
          status: existing.status,
        },
      },
      summary: `Already applied: ${existing.applicationId}`,
    };
  }

  const rate = await ctx.services.goldRate.current();
  const quote = buildQuote(request, [scheme], rate.rate24kPaisePerGram);
  const planQuote = quote.quotes[0];
  if (!planQuote) throw new Error("Quote for the selected plan is missing");

  const summary: ConfirmationSummary = {
    confirmationId: randomUUID(),
    fullName: request.fullName,
    mobileNumber: maskMobile(request.mobileNumber),
    grossWeightGrams: request.grossWeightGrams,
    netWeightGrams: request.netWeightGrams,
    karat: request.karat,
    planId: scheme.id,
    planName: scheme.name,
    pureGoldGrams: quote.pureGoldGrams,
    goldValue: quote.goldValue,
    eligibleLoan: planQuote.eligibleLoan,
    appliedLtvPercent: planQuote.appliedLtvPercent,
    annualInterestRatePercent: planQuote.annualInterestRatePercent,
    tenureMonths: planQuote.tenureMonths,
  };

  // Only the newest card can be confirmed; an older one would carry stale details.
  for (const pending of ctx.session.pending.values()) {
    if (pending.state === "OPEN") pending.state = "SUPERSEDED";
  }
  const pending: PendingConfirmation = { summary, request, state: "OPEN", createdAt: new Date() };
  ctx.session.pending.set(summary.confirmationId, pending);
  ctx.onConfirmation(summary);

  return {
    ok: true,
    payload: {
      ok: true,
      status: "AWAITING_USER_CONFIRMATION",
      submitted: false,
      summary: {
        ...summary,
        goldValueFormatted: formatInr(summary.goldValue),
        eligibleLoanFormatted: formatInr(summary.eligibleLoan),
      },
      instruction:
        "Nothing is filed yet. Ask the user to review the confirmation card and press Confirm (or Cancel). Do not say it is submitted.",
    },
    summary: "Waiting for your confirmation",
  };
}

export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<{ result: ToolResult; outcome: ToolOutcome }> {
  let outcome: ToolOutcome;
  switch (call.name) {
    case "get_loan_schemes":
      outcome = await getLoanSchemes(ctx);
      break;
    case "calculate_quote":
      outcome = await calculateQuote(call.input, ctx);
      break;
    case "check_existing_application":
      outcome = await checkExisting(call.input, ctx);
      break;
    case "submit_application":
      outcome = await prepareApplication(call.input, ctx);
      break;
    default:
      outcome = {
        ok: false,
        payload: { ok: false, error: { code: "UNKNOWN_TOOL", message: `No tool named ${call.name}` } },
        summary: "Unknown tool",
      };
  }
  return {
    outcome,
    result: {
      toolCallId: call.id,
      name: call.name,
      content: JSON.stringify(outcome.payload),
      isError: !outcome.ok,
    },
  };
}
