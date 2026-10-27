import OpenAI from "openai";
import type {
  ResponseInputItem,
  ResponseOutputItem,
  Response as OpenAIResponse,
} from "openai/resources/responses/responses";
import type { ChatMessage, CompletionRequest, LlmProvider, ModelTurn, StopReason, ToolCall } from "../types.js";

export type OpenAIReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface OpenAIProviderOptions {
  apiKey?: string;
  model: string;
  reasoningEffort: OpenAIReasoningEffort;
  client?: OpenAI;
}

function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Handed to the Zod validator, which reports it back to the model as a field error.
    return { __unparseable: text };
  }
}

/**
 * Neutral history → Responses API input items. Assistant turns produced by this provider replay
 * their raw output items (messages, function calls and encrypted reasoning) unchanged.
 */
export function toOpenAIInput(messages: ChatMessage[], providerName: string): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      input.push({ role: "user", content: message.content });
    } else if (message.role === "tool_results") {
      for (const result of message.results) {
        input.push({ type: "function_call_output", call_id: result.toolCallId, output: result.content });
      }
    } else if (message.provider === providerName && Array.isArray(message.raw)) {
      input.push(...(message.raw as ResponseInputItem[]));
    } else {
      if (message.text) input.push({ role: "assistant", content: message.text });
      for (const call of message.toolCalls) {
        input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.input ?? {}) });
      }
    }
  }
  return input;
}

export function fromOpenAIResponse(response: Pick<OpenAIResponse, "output" | "status" | "incomplete_details">): ModelTurn {
  const toolCalls: ToolCall[] = [];
  const text: string[] = [];
  let refused = false;

  for (const item of response.output as ResponseOutputItem[]) {
    if (item.type === "function_call") {
      toolCalls.push({ id: item.call_id, name: item.name, input: parseArguments(item.arguments) });
    } else if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") text.push(part.text);
        if (part.type === "refusal") refused = true;
      }
    }
  }

  let stopReason: StopReason = toolCalls.length > 0 ? "tool_use" : "end_turn";
  if (refused || response.incomplete_details?.reason === "content_filter") stopReason = "refusal";
  else if (response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens") {
    stopReason = toolCalls.length > 0 ? "tool_use" : "max_tokens";
  }

  return { text: text.join("\n").trim(), toolCalls, stopReason, raw: response.output };
}

/**
 * OpenAI via the Responses API with function tools. `store: false` keeps borrower details out of
 * OpenAI's stored conversations; reasoning items are requested in encrypted form so they can be
 * passed back on the next call without server-side state.
 */
export class OpenAIProvider implements LlmProvider {
  readonly name = "openai";
  readonly model: string;
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAIProviderOptions) {
    this.model = options.model;
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey, maxRetries: 2, timeout: 60_000 });
  }

  async complete(request: CompletionRequest): Promise<ModelTurn> {
    const response = await this.client.responses.create({
      model: this.model,
      instructions: request.system,
      input: toOpenAIInput(request.messages, this.name),
      tools: request.tools.map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        // Arguments are validated by our own Zod schemas, which are stricter than OpenAI's strict mode allows.
        strict: false,
      })),
      reasoning: { effort: this.options.reasoningEffort },
      max_output_tokens: 4096,
      store: false,
      include: ["reasoning.encrypted_content"],
    });
    return fromOpenAIResponse(response);
  }
}
