import type OpenAI from "openai";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { OpenAIProvider, fromOpenAIResponse, toOpenAIInput } from "../../src/agent/providers/openai.js";
import { TOOL_SPECS } from "../../src/agent/tools.js";
import { loadConfig } from "../../src/config.js";
import { createProvider } from "../../src/app.js";
import { createTestContext, type TestContext } from "../helpers.js";

type CreateArgs = Record<string, unknown> & { input: unknown[] };

/** Stands in for the SDK client: records each responses.create call and replays canned responses. */
function fakeClient(responses: unknown[]) {
  const calls: CreateArgs[] = [];
  const client = {
    responses: {
      create: async (args: CreateArgs) => {
        calls.push(structuredClone(args));
        const next = responses.shift();
        if (!next) throw new Error("fake OpenAI client ran out of responses");
        return next;
      },
    },
  } as unknown as OpenAI;
  return { client, calls };
}

const functionCall = (callId: string, name: string, args: unknown) => ({
  status: "completed",
  incomplete_details: null,
  output: [
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" },
    { type: "function_call", id: "fc_1", call_id: callId, name, arguments: JSON.stringify(args), status: "completed" },
  ],
});

const message = (text: string) => ({
  status: "completed",
  incomplete_details: null,
  output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
});

describe("OpenAI response mapping", () => {
  it("reads function calls and parses their JSON arguments", () => {
    const turn = fromOpenAIResponse(functionCall("call_9", "calculate_quote", { netWeightGrams: 45 }) as never);
    expect(turn.stopReason).toBe("tool_use");
    expect(turn.toolCalls).toEqual([{ id: "call_9", name: "calculate_quote", input: { netWeightGrams: 45 } }]);
  });

  it("passes unparseable arguments through so Zod can report them to the model", () => {
    const turn = fromOpenAIResponse({
      status: "completed",
      incomplete_details: null,
      output: [{ type: "function_call", call_id: "c", name: "calculate_quote", arguments: "{not json" }],
    } as never);
    expect(turn.toolCalls[0]?.input).toEqual({ __unparseable: "{not json" });
  });

  it("maps refusals, content filtering and truncation", () => {
    expect(
      fromOpenAIResponse({
        status: "completed",
        incomplete_details: null,
        output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "no" }] }],
      } as never).stopReason,
    ).toBe("refusal");
    expect(
      fromOpenAIResponse({ status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] } as never).stopReason,
    ).toBe("refusal");
    expect(
      fromOpenAIResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] } as never)
        .stopReason,
    ).toBe("max_tokens");
  });

  it("replays this provider's raw output items and converts everything else", () => {
    const raw = functionCall("call_1", "get_loan_schemes", {}).output;
    const input = toOpenAIInput(
      [
        { role: "user", content: "plans?" },
        { role: "assistant", text: "", toolCalls: [{ id: "call_1", name: "get_loan_schemes", input: {} }], raw, provider: "openai" },
        { role: "tool_results", results: [{ toolCallId: "call_1", name: "get_loan_schemes", content: "{}", isError: false }] },
        { role: "assistant", text: "Here they are.", toolCalls: [], provider: "scripted" },
      ],
      "openai",
    );
    expect(input).toEqual([
      { role: "user", content: "plans?" },
      ...raw,
      { type: "function_call_output", call_id: "call_1", output: "{}" },
      { role: "assistant", content: "Here they are." },
    ]);
  });
});

describe("OpenAIProvider request", () => {
  it("sends the system prompt, function tools, reasoning effort and store: false", async () => {
    const { client, calls } = fakeClient([message("Hi")]);
    const provider = new OpenAIProvider({ model: "gpt-6.1-terra", reasoningEffort: "low", client });
    const turn = await provider.complete({ system: "SYSTEM", messages: [{ role: "user", content: "hello" }], tools: TOOL_SPECS });

    expect(turn).toMatchObject({ text: "Hi", toolCalls: [], stopReason: "end_turn" });
    const args = calls[0]!;
    expect(args).toMatchObject({
      model: "gpt-6.1-terra",
      instructions: "SYSTEM",
      input: [{ role: "user", content: "hello" }],
      reasoning: { effort: "low" },
      store: false,
      include: ["reasoning.encrypted_content"],
    });
    const tools = args.tools as { type: string; name: string; parameters: unknown; strict: boolean }[];
    expect(tools.map((t) => t.name)).toEqual(TOOL_SPECS.map((t) => t.name));
    expect(tools.every((t) => t.type === "function" && t.strict === false && t.parameters)).toBe(true);
  });
});

describe("provider selection", () => {
  it("picks OpenAI when its key is set, and respects an explicit LLM_PROVIDER", () => {
    const openai = loadConfig({ OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "", LLM_PROVIDER: "" });
    expect(openai.llmProvider).toBe("openai");
    expect(createProvider(openai)).toMatchObject({ name: "openai", model: "gpt-6.1-terra" });

    const anthropic = loadConfig({ OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-ant-test", LLM_PROVIDER: "anthropic" });
    expect(createProvider(anthropic)?.name).toBe("anthropic");

    const none = loadConfig({ OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", LLM_PROVIDER: "" });
    expect(createProvider(none)).toBeNull();
  });
});

describe("full agent turn through the OpenAI provider", () => {
  let ctx: TestContext | undefined;
  afterEach(async () => {
    await ctx?.close();
  });

  it("calls the quote tool, returns its result to the model as function_call_output, and replies", async () => {
    const { client, calls } = fakeClient([
      functionCall("call_q", "calculate_quote", { netWeightGrams: 45, grossWeightGrams: 48, karat: 22 }),
      message("You can get up to ₹2,16,562 on the Monthly EMI plan."),
    ]);
    ctx = await createTestContext({ provider: new OpenAIProvider({ model: "gpt-6.1-terra", reasoningEffort: "low", client }) });

    const res = await request(ctx.app).post("/api/v1/agent/chat").send({ message: "45 g net, 48 g gross, 22K?" }).expect(200);
    expect(res.body.reply).toBe("You can get up to ₹2,16,562 on the Monthly EMI plan.");

    // Second call carries the reasoning item, the function call and our tool output, in order.
    const second = calls[1]!.input as { type?: string; call_id?: string; output?: string }[];
    expect(second.map((item) => item.type ?? "message")).toEqual(["message", "reasoning", "function_call", "function_call_output"]);
    const output = JSON.parse(second[3]!.output!) as { plans: { eligibleLoanFormatted: string }[] };
    expect(second[3]!.call_id).toBe("call_q");
    expect(output.plans.map((p) => p.eligibleLoanFormatted)).toEqual(["₹2,02,125", "₹2,16,562"]);
  });
});
