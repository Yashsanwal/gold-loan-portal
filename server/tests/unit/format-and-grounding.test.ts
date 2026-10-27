import { describe, expect, it } from "vitest";
import { formatDateIst, formatInr, maskMobile, maskMobilesInText } from "@goldloan/shared";
import { findUngroundedNumbers } from "../../src/agent/grounding.js";
import { GoldRateService } from "../../src/services/gold-rate.js";

describe("formatting", () => {
  it("uses Indian digit grouping", () => {
    expect(formatInr(216562)).toBe("₹2,16,562");
    expect(formatInr(288750)).toBe("₹2,88,750");
    expect(formatInr(64166.67)).toBe("₹64,166.67");
  });

  it("masks mobiles as 9876XXXX10", () => {
    expect(maskMobile("9876543210")).toBe("9876XXXX10");
    expect(maskMobile("bad")).toBe("XXXXXXXXXX");
  });

  it("masks every mobile inside free text but leaves other numbers alone", () => {
    expect(maskMobilesInText('{"m":"9876543210","n":"call 8123456789 now","amt":216562,"id":12345678901}')).toBe(
      '{"m":"9876XXXX10","n":"call 8123XXXX89 now","amt":216562,"id":12345678901}',
    );
  });

  it("formats dates in IST", () => {
    // 22:00 UTC on 2 Oct is already 3 Oct in India
    expect(formatDateIst("2026-10-02T22:00:00.000Z")).toBe("3 Oct 2026");
  });
});

describe("numeric grounding guard", () => {
  const toolResult = JSON.stringify({
    pureGoldGrams: 41.25,
    goldValueFormatted: "₹2,88,750",
    plans: [{ eligibleLoanFormatted: "₹2,16,562", appliedLtvPercent: 75 }],
  });

  it("accepts figures copied from tool results", () => {
    expect(findUngroundedNumbers("You can get up to ₹2,16,562 (75% LTV) on 41.25 g pure gold.", [toolResult])).toEqual([]);
  });

  it("flags figures the model computed itself", () => {
    expect(findUngroundedNumbers("Your EMI would be about ₹19,090 a month, roughly 2.17 lakh total.", [toolResult])).toEqual([
      "19,090",
      "2.17",
    ]);
  });

  it("allows numbers the user said, small counts, and masked mobiles", () => {
    const user = "I have 45 grams, my number is 9876543210";
    expect(findUngroundedNumbers("Got it: 45 g, 2 plans, mobile 9876XXXX10.", [user])).toEqual([]);
  });
});

describe("gold rate cache", () => {
  it("serves the cached rate until the TTL passes and dedupes concurrent refreshes", async () => {
    let calls = 0;
    let now = new Date("2026-10-27T00:00:00Z");
    const service = new GoldRateService(
      async () => {
        calls++;
        return { rate24kPerGram: 7000, source: "MOCK" };
      },
      300,
      () => now,
    );
    const [a, b] = await Promise.all([service.current(), service.current()]);
    expect(calls).toBe(1);
    expect(a.rate24kPaisePerGram).toBe(700_000);
    expect(b).toBe(a);

    now = new Date(now.getTime() + 299_000);
    await service.current();
    expect(calls).toBe(1);

    now = new Date(now.getTime() + 2_000);
    await service.current();
    expect(calls).toBe(2);
  });
});
