import { sql } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leadRequestSchema } from "@goldloan/shared";
import { leads } from "../../src/db/schema.js";
import { createTestContext, validLead, type TestContext } from "../helpers.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  request(ctx.app).post("/api/v1/leads").set(headers).send(body as object);

function expectErrorShape(body: unknown) {
  expect(body).toEqual({
    error: expect.objectContaining({ code: expect.any(String), message: expect.any(String), fields: expect.any(Array) }),
  });
}

describe("GET /api/v1/loan-schemes", () => {
  it("returns the seeded plans, never above 75% LTV", async () => {
    const res = await request(ctx.app).get("/api/v1/loan-schemes").expect(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({ id: "PLAN_BULLET_01", annualInterestRatePercent: 12, maxLtvPercent: 70, tenureMonths: 12 }),
      expect.objectContaining({ id: "PLAN_EMI_01", annualInterestRatePercent: 10.5, maxLtvPercent: 75, tenureMonths: 12 }),
    ]);
  });

  it("the database refuses a plan above 75% LTV", async () => {
    await expect(
      ctx.database.db.execute(
        sql`insert into loan_schemes (id, name, repayment_type, annual_interest_rate_bps, tenure_months, max_ltv_bps) values ('BAD', 'Bad', 'EMI', 1000, 12, 8000)`,
      ),
    ).rejects.toThrow();
  });
});

describe("POST /api/v1/quotes", () => {
  it("#1/#2 45 g 22K returns both plan loans", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/quotes")
      .send({ netWeightGrams: 45, grossWeightGrams: 48, karat: 22 })
      .expect(200);
    expect(res.body).toMatchObject({ pureGoldGrams: 41.25, goldValue: 288750, rate24kPerGram: 7000 });
    expect(res.body.quotes).toEqual([
      expect.objectContaining({ planId: "PLAN_BULLET_01", eligibleLoan: 202125, appliedLtvPercent: 70 }),
      expect.objectContaining({ planId: "PLAN_EMI_01", eligibleLoan: 216562, appliedLtvPercent: 75 }),
    ]);
  });

  it("#3 10 g 18K", async () => {
    const res = await request(ctx.app).post("/api/v1/quotes").send({ netWeightGrams: 10, grossWeightGrams: 12, karat: 18 });
    expect(res.body.pureGoldGrams).toBe(7.5);
    expect(res.body.goldValue).toBe(52500);
    expect(res.body.quotes[1].eligibleLoan).toBe(39375);
  });

  it("is a pure calculation: no lead is written", async () => {
    await request(ctx.app).post("/api/v1/quotes").send({ netWeightGrams: 45, grossWeightGrams: 48, karat: 22 }).expect(200);
    const rows = await ctx.database.db.select().from(leads);
    expect(rows).toHaveLength(0);
  });

  it("#4 net > gross → 400 with a netWeightGrams field error", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/quotes")
      .send({ netWeightGrams: 52, grossWeightGrams: 50, karat: 22 })
      .expect(400);
    expectErrorShape(res.body);
    expect(res.body.error.fields).toEqual([{ field: "netWeightGrams", message: "Net weight cannot be more than gross weight" }]);
  });
});

describe("POST /api/v1/leads", () => {
  it("#1 creates a lead → 201 with an applicationId and server-computed numbers", async () => {
    const res = await post(validLead()).expect(201);
    expect(res.body.applicationId).toMatch(/^GL-\d+$/);
    expect(res.headers.location).toBe(`/api/v1/leads/${res.body.applicationId}`);
    expect(res.body.lead).toMatchObject({
      status: "SUBMITTED",
      source: "FORM",
      mobileNumber: "9876XXXX10",
      pureGoldGrams: 41.25,
      goldValue: 288750,
      eligibleLoan: 216562,
    });
  });

  it("never trusts client-sent numbers", async () => {
    const res = await post({ ...validLead(), eligibleLoan: 99_999_999, goldValue: 1, pureGoldGrams: 999 }).expect(201);
    expect(res.body.lead.eligibleLoan).toBe(216562);
    const [row] = await ctx.database.db.select().from(leads);
    expect(row?.eligibleLoanPaise).toBe(21_656_200);
    expect(row?.goldValuePaise).toBe(28_875_000);
    expect(row?.netWeightMg).toBe(45_000);
  });

  it("#2 Bullet plan is capped at 70% LTV", async () => {
    const res = await post(validLead({ planId: "PLAN_BULLET_01" })).expect(201);
    expect(res.body.lead.eligibleLoan).toBe(202125);
    expect(res.body.lead.appliedLtvPercent).toBe(70);
  });

  it("#4 net > gross → 400 with netWeightGrams", async () => {
    const res = await post(validLead({ netWeightGrams: 52, grossWeightGrams: 50 })).expect(400);
    expectErrorShape(res.body);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.fields.map((f: { field: string }) => f.field)).toEqual(["netWeightGrams"]);
  });

  it.each(["5876543210", "98765"])("#5 mobile %s → 400 with mobileNumber", async (mobileNumber) => {
    const res = await post(validLead({ mobileNumber })).expect(400);
    expect(res.body.error.fields).toEqual([{ field: "mobileNumber", message: expect.stringContaining("10-digit") }]);
  });

  it("unknown plan → 404", async () => {
    const res = await post(validLead({ planId: "PLAN_GOLDEN_99" })).expect(404);
    expect(res.body.error.code).toBe("PLAN_NOT_FOUND");
    expect(res.body.error.fields).toEqual([{ field: "planId", message: expect.any(String) }]);
  });

  it("#6 same mobile within 7 days → 409 with the existing applicationId", async () => {
    const first = await post(validLead()).expect(201);
    const second = await post(validLead({ fullName: "Someone Else", planId: "PLAN_BULLET_01" })).expect(409);
    expectErrorShape(second.body);
    expect(second.body.error.code).toBe("DUPLICATE_APPLICATION");
    expect(second.body.error.details.applicationId).toBe(first.body.applicationId);
    expect(second.body.error.message).toContain(`application ${first.body.applicationId}`);
    expect(second.body.error.message).toMatch(/You already applied on \d{1,2} \w{3} \d{4}/);
  });

  it("allows the same mobile again once the 7-day window has passed", async () => {
    const first = await post(validLead()).expect(201);
    await ctx.database.db.execute(
      sql`update leads set created_at = now() - interval '7 days 1 minute' where application_id = ${first.body.applicationId}`,
    );
    await post(validLead()).expect(201);
  });

  it("#7 same Idempotency-Key and body → the original 201 is replayed", async () => {
    const key = "test-key-123";
    const first = await post(validLead(), { "Idempotency-Key": key }).expect(201);
    const replay = await post(validLead(), { "Idempotency-Key": key }).expect(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(first.body);
    expect(await ctx.database.db.select().from(leads)).toHaveLength(1);
  });

  it("same Idempotency-Key with a different body → 422", async () => {
    await post(validLead(), { "Idempotency-Key": "k-1" }).expect(201);
    const res = await post(validLead({ netWeightGrams: 40 }), { "Idempotency-Key": "k-1" }).expect(422);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("rejects a malformed Idempotency-Key", async () => {
    const res = await post(validLead(), { "Idempotency-Key": "has spaces" }).expect(400);
    expect(res.body.error.fields[0].field).toBe("Idempotency-Key");
  });

  it("#8 two parallel requests for the same new mobile → exactly one 201 and one 409", async () => {
    const results = await Promise.all([post(validLead()), post(validLead({ fullName: "Twin Request" }))]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    const created = results.find((r) => r.status === 201);
    const conflict = results.find((r) => r.status === 409);
    expect(conflict?.body.error.details.applicationId).toBe(created?.body.applicationId);
    expect(await ctx.database.db.select().from(leads)).toHaveLength(1);
  });

  it("a burst of 20 parallel requests for one mobile still creates exactly one lead", async () => {
    // End-to-end sanity check over HTTP. HTTP parsing staggers requests enough that this test alone
    // does not reliably expose a missing lock; the service-level test below is the regression guard.
    const server = ctx.app.listen(0);
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          request(server)
            .post("/api/v1/leads")
            .send(validLead({ fullName: `Burst Request ${String.fromCharCode(65 + i)}` })),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(19);
      expect(await ctx.database.db.select().from(leads)).toHaveLength(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // Verified to fail on PostgreSQL (TEST_DATABASE_URL) when the per-mobile advisory lock is removed:
  // 5 of 20 concurrent creates inserted. On PGlite (single connection) it passes either way.
  it("the service layer itself is race-free (20 concurrent creates, one lead)", async () => {
    const input = leadRequestSchema.parse(validLead());
    const results = await Promise.all(
      Array.from({ length: 20 }, () => ctx.services.leads.create(input, { source: "FORM" })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await ctx.database.db.select().from(leads)).toHaveLength(1);
  });

  it("ten parallel requests with one Idempotency-Key create one lead and all get the same 201", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => post(validLead(), { "Idempotency-Key": "burst" })));
    expect(new Set(results.map((r) => r.status))).toEqual(new Set([201]));
    expect(new Set(results.map((r) => r.body.applicationId)).size).toBe(1);
    expect(await ctx.database.db.select().from(leads)).toHaveLength(1);
  });

  it("logs never contain a full mobile number", async () => {
    await post(validLead()).expect(201);
    await post(validLead()).expect(409);
    expect(ctx.logs.join("\n")).not.toContain("9876543210");
  });
});

describe("GET /api/v1/leads", () => {
  async function seedLeads() {
    await post(validLead({ mobileNumber: "9000000001", planId: "PLAN_EMI_01" })).expect(201);
    await post(validLead({ mobileNumber: "9000000002", planId: "PLAN_BULLET_01" })).expect(201);
    await post(validLead({ mobileNumber: "9000000003", planId: "PLAN_EMI_01" })).expect(201);
  }

  it("lists newest first with masked mobiles", async () => {
    await seedLeads();
    const res = await request(ctx.app).get("/api/v1/leads").expect(200);
    expect(res.body.data.map((l: { mobileNumber: string }) => l.mobileNumber)).toEqual([
      "9000XXXX03",
      "9000XXXX02",
      "9000XXXX01",
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/9000000\d{3}/);
    expect(res.body.pagination).toEqual({ page: 1, pageSize: 20, total: 3, totalPages: 1 });
  });

  it("filters by plan and paginates", async () => {
    await seedLeads();
    const filtered = await request(ctx.app).get("/api/v1/leads?planId=PLAN_EMI_01").expect(200);
    expect(filtered.body.data).toHaveLength(2);
    expect(filtered.body.data.every((l: { planId: string }) => l.planId === "PLAN_EMI_01")).toBe(true);

    const page2 = await request(ctx.app).get("/api/v1/leads?page=2&pageSize=2").expect(200);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.pagination).toEqual({ page: 2, pageSize: 2, total: 3, totalPages: 2 });
  });

  it("rejects bad query parameters with 400", async () => {
    const res = await request(ctx.app).get("/api/v1/leads?pageSize=500&status=NOPE").expect(400);
    expect(res.body.error.fields.map((f: { field: string }) => f.field).sort()).toEqual(["pageSize", "status"]);
  });
});

describe("status workflow and audit log", () => {
  it("moves SUBMITTED → UNDER_REVIEW → APPROVED and records each step", async () => {
    const { body } = await post(validLead()).expect(201);
    const id = body.applicationId;

    await request(ctx.app).patch(`/api/v1/leads/${id}/status`).send({ status: "UNDER_REVIEW" }).expect(200);
    const approved = await request(ctx.app)
      .patch(`/api/v1/leads/${id}/status`)
      .send({ status: "APPROVED", note: "Gold verified at branch" })
      .expect(200);

    expect(approved.body.lead.status).toBe("APPROVED");
    expect(approved.body.audit.map((a: { fromStatus: string | null; toStatus: string }) => [a.fromStatus, a.toStatus])).toEqual([
      [null, "SUBMITTED"],
      ["SUBMITTED", "UNDER_REVIEW"],
      ["UNDER_REVIEW", "APPROVED"],
    ]);
    expect(approved.body.audit[2].note).toBe("Gold verified at branch");
  });

  it("rejects skipping a step with 409", async () => {
    const { body } = await post(validLead()).expect(201);
    const res = await request(ctx.app).patch(`/api/v1/leads/${body.applicationId}/status`).send({ status: "APPROVED" }).expect(409);
    expect(res.body.error.code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("404 for an unknown application, 400 for a malformed id", async () => {
    await request(ctx.app).get("/api/v1/leads/GL-999999").expect(404);
    const bad = await request(ctx.app).get("/api/v1/leads/abc").expect(400);
    expect(bad.body.error.fields[0].field).toBe("applicationId");
  });
});
