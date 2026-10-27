import { z } from "zod";
import { KARATS, MAX_WEIGHT_GRAMS, hasAtMostThreeDecimals } from "./money.js";

/**
 * One set of schemas for the API, the web form and the agent's tools,
 * so the three paths can never disagree about what a valid application is.
 */

export const NAME_PATTERN = /^[\p{L}\p{M}]+(?: [\p{L}\p{M}]+)*$/u;
export const MOBILE_PATTERN = /^[6-9]\d{9}$/;

export const LEAD_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Allowed status workflow: SUBMITTED → UNDER_REVIEW → APPROVED / REJECTED. */
export const STATUS_TRANSITIONS: Record<LeadStatus, readonly LeadStatus[]> = {
  SUBMITTED: ["UNDER_REVIEW"],
  UNDER_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: [],
  REJECTED: [],
};

const weight = (label: string) =>
  z
    .number({ error: `${label} must be a number in grams` })
    .gt(0, { error: `${label} must be greater than 0 g` })
    .max(MAX_WEIGHT_GRAMS, { error: `${label} cannot exceed ${MAX_WEIGHT_GRAMS} g` })
    .refine(hasAtMostThreeDecimals, { error: `${label} can have at most 3 decimal places` });

export const karatSchema = z.literal(KARATS, { error: "Karat must be 18, 22 or 24" });

export const fullNameSchema = z
  .string({ error: "Full name is required" })
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(2, { error: "Name must be at least 2 characters" })
      .max(60, { error: "Name must be at most 60 characters" })
      .regex(NAME_PATTERN, { error: "Name can contain only letters and spaces" }),
  );

export const mobileNumberSchema = z
  .string({ error: "Mobile number is required" })
  .trim()
  .regex(MOBILE_PATTERN, {
    error: "Enter a valid 10-digit Indian mobile number starting with 6, 7, 8 or 9",
  });

export const planIdSchema = z
  .string({ error: "Plan is required" })
  .trim()
  .min(1, { error: "Plan is required" })
  .max(64, { error: "Plan id is too long" });

const goldShape = {
  grossWeightGrams: weight("Gross weight"),
  netWeightGrams: weight("Net weight"),
  karat: karatSchema,
};

const NET_ABOVE_GROSS = "Net weight cannot be more than gross weight";

/**
 * Cross-field rule. It still runs when *other* fields (name, mobile…) are invalid, so a user
 * sees every problem at once, but not when either weight itself failed to parse.
 */
const netNotAboveGross = {
  path: ["netWeightGrams"],
  error: NET_ABOVE_GROSS,
  when(payload: z.core.ParsePayload): boolean {
    const value = payload.value as Record<string, unknown> | undefined;
    const weightIssue = payload.issues.some(
      (issue) => issue.path?.[0] === "netWeightGrams" || issue.path?.[0] === "grossWeightGrams",
    );
    return (
      !weightIssue &&
      typeof value?.netWeightGrams === "number" &&
      typeof value?.grossWeightGrams === "number"
    );
  },
};

const netLeGross = (value: { netWeightGrams: number; grossWeightGrams: number }) =>
  value.netWeightGrams <= value.grossWeightGrams;

export const quoteRequestSchema = z.object(goldShape).refine(netLeGross, netNotAboveGross);
export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

export const leadRequestSchema = z
  .object({
    fullName: fullNameSchema,
    mobileNumber: mobileNumberSchema,
    ...goldShape,
    planId: planIdSchema,
  })
  .refine(netLeGross, netNotAboveGross);
export type LeadRequest = z.infer<typeof leadRequestSchema>;
export type LeadRequestInput = z.input<typeof leadRequestSchema>;

export const statusUpdateSchema = z.object({
  status: z.enum(LEAD_STATUSES, { error: `Status must be one of ${LEAD_STATUSES.join(", ")}` }),
  note: z.string().trim().max(500, { error: "Note must be at most 500 characters" }).optional(),
});
export type StatusUpdate = z.infer<typeof statusUpdateSchema>;

export interface FieldError {
  field: string;
  message: string;
}

/** Flattens Zod issues into the API's `fields[]` shape. One message per field, first wins. */
export function toFieldErrors(error: z.ZodError): FieldError[] {
  const seen = new Set<string>();
  const fields: FieldError[] = [];
  for (const issue of error.issues) {
    const field = issue.path.length > 0 ? issue.path.map(String).join(".") : "body";
    if (seen.has(field)) continue;
    seen.add(field);
    fields.push({ field, message: issue.message });
  }
  return fields;
}
