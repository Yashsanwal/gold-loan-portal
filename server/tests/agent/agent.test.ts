import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leads } from "../../src/db/schema.js";
import { toAnthropicMessages } from "../../src/agent/providers/anthropic.js";
import { TOOL_SPECS } from "../../src/agent/tools.js";
import { createTestContext, validLead, type TestContext } from "../helpers.js";
import { ScriptedProvider, lastToolResult, say, toolCall, use } from "../scripted-provider.js";

let ctx: TestContext;
let model: ScriptedProvider;

beforeEach(async () => {
  model = new ScriptedProvider();
  ctx = await createTestContext({ provider: model });
});
afterEach(async () => {
  await ctx.close();
});

const chat = (message: string, sessionId?: string) =>
  request(ctx.app).post("/api/v1/agent/chat").send({ message, ...(sessionId ? { sessionId } : {}) });

const confirm = (sessionId: string, confirmationId: string, decision: "confirm" | "cancel" = "confirm") =>
  request(ctx.app).post(`/api/v1/agent/sessions/${sessionId}/confirmations/${confirmationId}`).send({ decision });

const application = { ...validLead() };

describe("tool definitions", () => {
  it("exposes exactly the four tools, with schemas generated from the API's Zod schemas", () => {
    expect(TOOL_SPECS.map((t) => t.name)).toEqual([
      "get_loan_schemes",
      "calculate_quote",
      "check_existing_application",
      "submit_application",
    ]);
    const submit = TOOL_SPECS.find((t) => t.name === "submit_application")!;
    expect((submit.inputSchema as { required: string[] }).required.sort()).toEqual(
      ["fullName", "grossWeightGrams", "karat", "mobileNumber", "netWeightGrams", "planId"].sort(),
    );
    const props = (submit.inputSchema as { properties: Record<string, { pattern?: string; enum?: number[] }> }).properties;
    expect(props.mobileNumber?.pattern).toBe("^[6-9]\\d{9}$");
    expect(props.karat?.enum).toEqual([18, 22, 24]);
  });
});

describe("happy path: quote → summary → confirm", () => {
  it("files the lead only after the UI confirmation, with the same numbers as the form", async () => {
    model.script(
      use(toolCall("calculate_quote", { netWeightGrams: 45, grossWeightGrams: 48, karat: 22 })),
      (req) => {
        const quote = lastToolResult(req.messages, "calculate_quote") as { plans: { eligibleLoanFormatted: string }[] };
        return say(`You can get up to ${quote.plans[1]!.eligibleLoanFormatted} on the Monthly EMI plan.`);
      },
    );
    const first = await chat("I have 45 grams of 22 carat jewellery, gross 48 g. How much can I get?").expect(200);
    expect(first.body.reply).toBe("You can get up to ₹2,16,562 on the Monthly EMI plan.");
    expect(first.body.events.map((e: { type: string }) => e.type)).toEqual(["session", "tool_start", "tool_end", "message", "done"]);
    const sessionId: string = first.body.sessionId;

    model.script(use(toolCall("submit_application", application)), say("Please review the card and press Confirm."));
    const second = await chat("Yes, apply. Ravi Kumar, 9876543210, EMI plan.", sessionId).expect(200);
    const card = second.body.confirmation;
    expect(card).toMatchObject({
      fullName: "Ravi Kumar",
      mobileNumber: "9876XXXX10",
      planId: "PLAN_EMI_01",
      eligibleLoan: 216562,
      goldValue: 288750,
      pureGoldGrams: 41.25,
    });

    // Nothing is filed until the human presses Confirm.
    expect(await ctx.database.db.select().from(leads)).toHaveLength(0);

    const filed = await confirm(sessionId, card.confirmationId).expect(201);
    expect(filed.body).toMatchObject({ outcome: "SUBMITTED", applicationId: expect.stringMatching(/^GL-\d+$/) });
    expect(filed.body.lead).toMatchObject({ source: "AGENT", eligibleLoan: 216562 });

    // Same truth, two paths: a form lead with the same input has identical numbers.
    const form = await request(ctx.app).post("/api/v1/leads").send(validLead({ mobileNumber: "9123456780" })).expect(201);
    const strip = ({ applicationId, mobileNumber, source, createdAt, updatedAt, ...rest }: Record<string, unknown>) => rest;
    expect(strip(filed.body.lead)).toEqual(strip(form.body.lead));

    // The model learns the outcome from a portal notice on the next turn.
    model.script(say("Done!"));
    await chat("thanks", sessionId).expect(200);
    const lastUser = model.requests.at(-1)!.messages.at(-1)!;
    expect(lastUser).toMatchObject({ role: "user" });
    expect((lastUser as { content: string }).content).toContain(`Application ${filed.body.applicationId} was submitted`);
  });

  it("a double-clicked Confirm files once and returns the same application", async () => {
    model.script(use(toolCall("submit_application", application)), say("Please confirm."));
    const res = await chat("apply for me").expect(200);
    const [a, b] = await Promise.all([
      confirm(res.body.sessionId, res.body.confirmation.confirmationId),
      confirm(res.body.sessionId, res.body.confirmation.confirmationId),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.applicationId).toBe(b.body.applicationId);
    expect(await ctx.database.db.select().from(leads)).toHaveLength(1);
  });

  it("cancel files nothing, and a cancelled card cannot be confirmed later", async () => {
    model.script(use(toolCall("submit_application", application)), say("Please confirm."));
    const res = await chat("apply").expect(200);
    const { sessionId } = res.body;
    const { confirmationId } = res.body.confirmation;
    await confirm(sessionId, confirmationId, "cancel").expect(200);
    const late = await confirm(sessionId, confirmationId).expect(409);
    expect(late.body.error.code).toBe("CONFIRMATION_CLOSED");
    expect(await ctx.database.db.select().from(leads)).toHaveLength(0);
  });

  it("a newer summary supersedes the old card (user changed their mind)", async () => {
    model.script(use(toolCall("submit_application", application)), say("Confirm?"));
    const first = await chat("apply on EMI").expect(200);
    model.script(use(toolCall("submit_application", { ...application, planId: "PLAN_BULLET_01" })), say("Updated, confirm?"));
    const second = await chat("actually make it bullet", first.body.sessionId).expect(200);

    await confirm(first.body.sessionId, first.body.confirmation.confirmationId).expect(409);
    const ok = await confirm(first.body.sessionId, second.body.confirmation.confirmationId).expect(201);
    expect(ok.body.lead).toMatchObject({ planId: "PLAN_BULLET_01", eligibleLoan: 202125 });
  });

  it("unknown or foreign confirmation ids → 404", async () => {
    model.script(use(toolCall("submit_application", application)), say("Confirm?"));
    const res = await chat("apply").expect(200);
    const other = "00000000-0000-4000-8000-000000000000";
    await confirm(other, res.body.confirmation.confirmationId).expect(404);
    await confirm(res.body.sessionId, other).expect(404);
  });
});

describe("validation round-trips", () => {
  it("net > gross: the model gets the field error back instead of a quote", async () => {
    model.script(use(toolCall("calculate_quote", { netWeightGrams: 52, grossWeightGrams: 50, karat: 22 })), (req) => {
      const result = lastToolResult(req.messages, "calculate_quote") as { error: { fields: { field: string }[] } };
      expect(result.error.fields).toEqual([{ field: "netWeightGrams", message: "Net weight cannot be more than gross weight" }]);
      return say("Net weight can't be more than gross weight. Could you check both weights?");
    });
    const res = await chat("net 52 g, gross 50 g, 22K").expect(200);
    const toolEnd = res.body.events.find((e: { type: string }) => e.type === "tool_end");
    expect(toolEnd).toMatchObject({ ok: false });
    const sent = model.requests[1]!.messages.at(-1)!;
    expect(sent).toMatchObject({ role: "tool_results", results: [expect.objectContaining({ isError: true })] });
  });

  it("an invalid submit_application payload creates no confirmation", async () => {
    model.script(use(toolCall("submit_application", { ...application, mobileNumber: "5876543210" })), say("That number looks wrong."));
    const res = await chat("apply with 5876543210").expect(200);
    expect(res.body.confirmation).toBeNull();
  });

  it("an unknown plan id is reported back to the model", async () => {
    model.script(use(toolCall("submit_application", { ...application, planId: "PLAN_PLATINUM" })), (req) => {
      expect(lastToolResult(req.messages, "submit_application")).toMatchObject({ ok: false, error: { code: "PLAN_NOT_FOUND" } });
      return say("Let me check the plans.");
    });
    const res = await chat("platinum plan please").expect(200);
    expect(res.body.confirmation).toBeNull();
  });
});

describe("duplicates within 7 days", () => {
  it("submit_application refuses before showing a card and returns the existing id", async () => {
    const existing = await request(ctx.app).post("/api/v1/leads").send(validLead()).expect(201);
    model.script(use(toolCall("submit_application", application)), (req) => {
      const result = lastToolResult(req.messages, "submit_application") as { error: { code: string; applicationId: string } };
      return say(`You already have application ${result.error.applicationId}.`);
    });
    const res = await chat("apply").expect(200);
    expect(res.body.confirmation).toBeNull();
    expect(res.body.reply).toBe(`You already have application ${existing.body.applicationId}.`);
  });

  it("check_existing_application reports a recent application with a masked mobile", async () => {
    const existing = await request(ctx.app).post("/api/v1/leads").send(validLead()).expect(201);
    model.script(use(toolCall("check_existing_application", { mobileNumber: "9876543210" })), (req) => {
      expect(lastToolResult(req.messages, "check_existing_application")).toMatchObject({
        exists: true,
        applicationId: existing.body.applicationId,
        mobileNumber: "9876XXXX10",
      });
      return say("Found it.");
    });
    await chat("did I already apply? 9876543210").expect(200);
  });

  it("a lead filed elsewhere between card and Confirm → 409 with the existing id", async () => {
    model.script(use(toolCall("submit_application", application)), say("Confirm?"));
    const res = await chat("apply").expect(200);
    const formLead = await request(ctx.app).post("/api/v1/leads").send(validLead()).expect(201);
    const conflict = await confirm(res.body.sessionId, res.body.confirmation.confirmationId).expect(409);
    expect(conflict.body.error.details.applicationId).toBe(formLead.body.applicationId);
  });
});

describe("guardrails", () => {
  it("rewrites a reply that states a number no tool produced (no maths by the model)", async () => {
    model.script(
      use(toolCall("calculate_quote", { netWeightGrams: 45, grossWeightGrams: 48, karat: 22 })),
      say("You can get ₹2,16,562, so your EMI will be about ₹19,090 per month."),
      (req) => {
        const nudge = req.messages.at(-1) as { role: string; content: string };
        expect(nudge.role).toBe("user");
        expect(nudge.content).toContain("19,090");
        return say("You can get up to ₹2,16,562 on the Monthly EMI plan.");
      },
    );
    const res = await chat("45g 22k gross 48, what's my EMI?").expect(200);
    expect(res.body.reply).toBe("You can get up to ₹2,16,562 on the Monthly EMI plan.");
  });

  it("falls back to the calculator's own figures if the model keeps inventing numbers", async () => {
    model.script(
      use(toolCall("calculate_quote", { netWeightGrams: 45, grossWeightGrams: 48, karat: 22 })),
      say("About 2.17 lakh."),
      say("Roughly 2.2 lakh."),
    );
    const res = await chat("45g 22k gross 48").expect(200);
    expect(res.body.reply).toContain("₹2,16,562");
    expect(res.body.reply).toContain("₹2,02,125");
    expect(res.body.reply).not.toContain("lakh");
  });

  it("a provider refusal becomes a polite on-topic reply", async () => {
    model.script({ text: "", toolCalls: [], stopReason: "refusal" });
    const res = await chat("something off-topic").expect(200);
    expect(res.body.reply).toMatch(/gold-loan/);
  });

  it("caps runaway tool loops", async () => {
    model.script(...Array.from({ length: 8 }, () => use(toolCall("get_loan_schemes"))));
    const res = await chat("loop").expect(200);
    expect(res.body.reply).toMatch(/couldn't finish/);
    expect(model.remaining).toBe(0);
  });

  it("does not commit history when the provider fails mid-turn", async () => {
    model.script(say("Hello!"));
    const { body } = await chat("hi").expect(200);

    model.script(use(toolCall("get_loan_schemes")), () => {
      throw new Error("upstream 529");
    });
    const failed = await chat("plans?", body.sessionId).expect(500);
    expect(failed.body.error.code).toBe("INTERNAL_ERROR");

    model.script(say("Here you go."));
    await chat("plans again?", body.sessionId).expect(200);
    // The failed turn (its user message, tool call and tool result) left no trace.
    expect(model.requests.at(-1)!.messages).toEqual([
      { role: "user", content: "hi" },
      expect.objectContaining({ role: "assistant", text: "Hello!" }),
      { role: "user", content: "plans again?" },
    ]);
  });

  it("validates chat input", async () => {
    await request(ctx.app).post("/api/v1/agent/chat").send({ message: "" }).expect(400);
    await request(ctx.app).post("/api/v1/agent/chat").send({ message: "x".repeat(2001) }).expect(400);
    await request(ctx.app).post("/api/v1/agent/chat").send({ message: "hi", sessionId: "nope" }).expect(400);
  });

  it("never logs a full mobile number", async () => {
    model.script(use(toolCall("check_existing_application", { mobileNumber: "9876543210" })), say("No application yet."));
    await chat("my number is 9876543210").expect(200);
    const logs = ctx.logs.join("\n");
    expect(logs).toContain("agent tool call");
    expect(logs).not.toContain("9876543210");
  });
});

describe("streaming", () => {
  it("streams tool-status events as Server-Sent Events", async () => {
    model.script(use(toolCall("get_loan_schemes")), say("We have two plans."));
    const res = await request(ctx.app)
      .post("/api/v1/agent/chat")
      .set("Accept", "text/event-stream")
      .send({ message: "what plans do you have?" })
      .expect(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = res.text
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk.split("\n").find((l) => l.startsWith("data: "))!.slice(6)));
    expect(events.map((e) => e.type)).toEqual(["session", "tool_start", "tool_end", "message", "done"]);
    expect(events[1]).toMatchObject({ name: "get_loan_schemes", label: "Fetching loan plans…" });
  });

  it("streams errors as an error event", async () => {
    model.script(() => {
      throw new Error("boom");
    });
    const res = await request(ctx.app)
      .post("/api/v1/agent/chat")
      .set("Accept", "text/event-stream")
      .send({ message: "hi" })
      .expect(200);
    expect(res.text).toContain("event: error");
    expect(res.text).not.toContain("boom");
  });
});

describe("availability", () => {
  it("returns 503 when no provider is configured", async () => {
    await ctx.close();
    ctx = await createTestContext({ provider: null });
    const res = await request(ctx.app).post("/api/v1/agent/chat").send({ message: "hi" }).expect(503);
    expect(res.body.error.code).toBe("AGENT_UNAVAILABLE");
    const status = await request(ctx.app).get("/api/v1/agent/status").expect(200);
    expect(status.body).toMatchObject({ available: false, provider: "none" });
  });
});

describe("anthropic message mapping", () => {
  it("merges tool results and a following user message into one user turn and replays raw blocks", () => {
    const raw = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "t1", name: "get_loan_schemes", input: {} }];
    const mapped = toAnthropicMessages(
      [
        { role: "user", content: "plans?" },
        { role: "assistant", text: "", toolCalls: [{ id: "t1", name: "get_loan_schemes", input: {} }], raw, provider: "anthropic" },
        { role: "tool_results", results: [{ toolCallId: "t1", name: "get_loan_schemes", content: "{}", isError: false }] },
        { role: "user", content: "hello?" },
      ],
      "anthropic",
    );
    expect(mapped.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(mapped[1]!.content).toBe(raw);
    expect(mapped[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "{}", is_error: false },
      { type: "text", text: "hello?" },
    ]);
  });
});
