import { describe, expect, it } from "vitest";
import { leadRequestSchema, quoteRequestSchema, toFieldErrors } from "@goldloan/shared";
import { validLead } from "../helpers.js";

function fieldErrors(input: unknown) {
  const result = leadRequestSchema.safeParse(input);
  return result.success ? [] : toFieldErrors(result.error);
}

const fieldsOf = (input: unknown) => fieldErrors(input).map((f) => f.field);

describe("lead validation", () => {
  it("accepts a valid application", () => {
    expect(leadRequestSchema.safeParse(validLead()).success).toBe(true);
  });

  it("#4 net 52 g > gross 50 g → error on netWeightGrams", () => {
    const errors = fieldErrors(validLead({ netWeightGrams: 52, grossWeightGrams: 50 }));
    expect(errors).toEqual([{ field: "netWeightGrams", message: "Net weight cannot be more than gross weight" }]);
  });

  it("net equal to gross is allowed", () => {
    expect(fieldsOf(validLead({ netWeightGrams: 50, grossWeightGrams: 50 }))).toEqual([]);
  });

  it.each(["5876543210", "98765", "98765432100", "98765 43210", "+919876543210", "abcdefghij", ""])(
    "#5 mobile %j → error on mobileNumber",
    (mobileNumber) => {
      expect(fieldsOf(validLead({ mobileNumber }))).toEqual(["mobileNumber"]);
    },
  );

  it.each(["6000000000", "7999999999", "8123456789", "9876543210", " 9876543210 "])("accepts mobile %j", (mobileNumber) => {
    expect(fieldsOf(validLead({ mobileNumber }))).toEqual([]);
  });

  it("rejects a mobile sent as a number", () => {
    expect(fieldsOf(validLead({ mobileNumber: 9876543210 }))).toEqual(["mobileNumber"]);
  });

  it.each([
    ["R", "Name must be at least 2 characters"],
    ["A".repeat(61), "Name must be at most 60 characters"],
    ["Ravi123", "Name can contain only letters and spaces"],
    ["Ravi_Kumar", "Name can contain only letters and spaces"],
    ["   ", "Name must be at least 2 characters"],
  ])("name %j → %s", (fullName, message) => {
    expect(fieldErrors(validLead({ fullName }))).toEqual([{ field: "fullName", message }]);
  });

  it("trims and collapses whitespace in names, and accepts Indic scripts", () => {
    expect(leadRequestSchema.parse(validLead({ fullName: "  Ravi   Kumar " })).fullName).toBe("Ravi Kumar");
    expect(leadRequestSchema.safeParse(validLead({ fullName: "रवि कुमार" })).success).toBe(true);
    expect(leadRequestSchema.safeParse(validLead({ fullName: "A".repeat(60) })).success).toBe(true);
  });

  it.each([17, 21, 23, "22", null])("karat %j → error", (karat) => {
    expect(fieldErrors(validLead({ karat }))).toEqual([{ field: "karat", message: "Karat must be 18, 22 or 24" }]);
  });

  it.each([
    [0, "Net weight must be greater than 0 g"],
    [-1, "Net weight must be greater than 0 g"],
    [45.1234, "Net weight can have at most 3 decimal places"],
    ["45", "Net weight must be a number in grams"],
  ])("net weight %j → %s", (netWeightGrams, message) => {
    expect(fieldErrors(validLead({ netWeightGrams }))).toEqual([{ field: "netWeightGrams", message }]);
  });

  it("gross weight above 1000 g is rejected; exactly 1000 g is allowed", () => {
    expect(fieldsOf(validLead({ grossWeightGrams: 1000.001 }))).toEqual(["grossWeightGrams"]);
    expect(fieldsOf(validLead({ grossWeightGrams: 1000, netWeightGrams: 1000 }))).toEqual([]);
  });

  it("reports the net > gross rule alongside unrelated field errors", () => {
    const fields = fieldsOf(validLead({ fullName: "X", netWeightGrams: 52, grossWeightGrams: 50 }));
    expect(fields).toEqual(expect.arrayContaining(["fullName", "netWeightGrams"]));
  });

  it("skips net > gross when a weight is itself invalid", () => {
    expect(fieldErrors(validLead({ netWeightGrams: 2000, grossWeightGrams: 50 }))).toEqual([
      { field: "netWeightGrams", message: "Net weight cannot exceed 1000 g" },
    ]);
  });

  it("reports every missing field", () => {
    expect(fieldsOf({}).sort()).toEqual(
      ["fullName", "grossWeightGrams", "karat", "mobileNumber", "netWeightGrams", "planId"].sort(),
    );
  });

  it("strips client-supplied money fields", () => {
    const parsed = leadRequestSchema.parse({ ...validLead(), eligibleLoan: 99_999_999, goldValue: 1 });
    expect(parsed).not.toHaveProperty("eligibleLoan");
    expect(parsed).not.toHaveProperty("goldValue");
  });
});

describe("quote validation", () => {
  it("requires gross weight so the net ≤ gross rule can be checked", () => {
    const result = quoteRequestSchema.safeParse({ netWeightGrams: 45, karat: 22 });
    expect(result.success).toBe(false);
  });
});
