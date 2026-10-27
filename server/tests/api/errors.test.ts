import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, validLead, type TestContext } from "../helpers.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

describe("error contract", () => {
  it("malformed JSON → 400 INVALID_JSON", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/leads")
      .set("Content-Type", "application/json")
      .send('{"fullName": ')
      .expect(400);
    expect(res.body).toEqual({
      error: { code: "INVALID_JSON", message: "Request body is not valid JSON", fields: [{ field: "body", message: "Malformed JSON" }] },
    });
  });

  it("missing or non-object body → 400 on body", async () => {
    const res = await request(ctx.app).post("/api/v1/quotes").set("Content-Type", "application/json").send("[1,2]").expect(400);
    expect(res.body.error.fields).toEqual([{ field: "body", message: expect.any(String) }]);
    await request(ctx.app).post("/api/v1/quotes").expect(400);
  });

  it("unknown routes → 404 JSON", async () => {
    const res = await request(ctx.app).get("/api/v1/nothing-here").expect(404);
    expect(res.body).toEqual({ error: { code: "ROUTE_NOT_FOUND", message: "No route for GET /api/v1/nothing-here", fields: [] } });
  });

  it("oversized bodies → 413", async () => {
    const res = await request(ctx.app).post("/api/v1/leads").send({ fullName: "A".repeat(40_000) }).expect(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("unexpected async failures → 500 JSON without stack traces, logged with a request id", async () => {
    ctx.services.schemes.listActive = async () => {
      throw new Error("connection reset by peer at Socket.read (db.ts:42)");
    };
    const res = await request(ctx.app).get("/api/v1/loan-schemes").expect(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect(res.body.error.fields).toEqual([]);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("connection reset");
    expect(text).not.toContain("db.ts");
    expect(res.body.error.message).toContain(res.headers["x-request-id"]);
    expect(ctx.logs.some((line) => line.includes("connection reset"))).toBe(true);
  });

  it("rate limits POST /leads with 429 in the standard shape", async () => {
    await ctx.close();
    ctx = await createTestContext({ env: { LEADS_RATE_LIMIT_PER_MINUTE: 2 } });
    await request(ctx.app).post("/api/v1/leads").send(validLead({ mobileNumber: "9000000001" })).expect(201);
    await request(ctx.app).post("/api/v1/leads").send(validLead({ mobileNumber: "9000000002" })).expect(201);
    const res = await request(ctx.app).post("/api/v1/leads").send(validLead({ mobileNumber: "9000000003" })).expect(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
  });

  it("gold-rate endpoint is cached", async () => {
    const res = await request(ctx.app).get("/api/v1/gold-rate").expect(200);
    expect(res.body).toMatchObject({ rate24kPerGram: 7000, currency: "INR", source: "MOCK" });
    expect(res.headers["cache-control"]).toMatch(/^public, max-age=\d+$/);
  });
});
