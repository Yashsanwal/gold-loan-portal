import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, CompletionRequest, LlmProvider, ModelTurn, StopReason, ToolCall } from "../types.js";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;

export interface AnthropicProviderOptions {
  apiKey?: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Server-side refusal fallback (beta). */
  fallbacks: boolean;
  client?: Anthropic;
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function toBlocks(message: Extract<ChatMessage, { role: "assistant" }>): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  if (message.text) blocks.push({ type: "text", text: message.text });
  for (const call of message.toolCalls) {
    blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input ?? {} });
  }
  return blocks;
}

/**
 * Converts the neutral history to Anthropic messages. Consecutive user-role entries
 * (tool results followed by a new user message) merge into one turn, which the API requires.
 * Assistant turns from this provider replay their raw blocks, so thinking blocks stay unchanged.
 */
export function toAnthropicMessages(messages: ChatMessage[], providerName: string): MessageParam[] {
  const out: MessageParam[] = [];
  const pushUser = (blocks: ContentBlockParam[]) => {
    const last = out.at(-1);
    if (last?.role === "user" && Array.isArray(last.content)) {
      last.content.push(...blocks);
    } else {
      out.push({ role: "user", content: blocks });
    }
  };

  for (const message of messages) {
    if (message.role === "user") {
      pushUser([{ type: "text", text: message.content }]);
    } else if (message.role === "tool_results") {
      pushUser(
        message.results.map((result) => ({
          type: "tool_result" as const,
          tool_use_id: result.toolCallId,
          content: result.content,
          is_error: result.isError,
        })),
      );
    } else {
      const content =
        message.provider === providerName && Array.isArray(message.raw)
          ? (message.raw as ContentBlockParam[])
          : toBlocks(message);
      out.push({ role: "assistant", content: content.length > 0 ? content : [{ type: "text", text: "…" }] });
    }
  }
  return out;
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicProviderOptions) {
    this.model = options.model;
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 2, timeout: 60_000 });
  }

  async complete(request: CompletionRequest): Promise<ModelTurn> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: request.system,
      messages: toAnthropicMessages(request.messages, this.name),
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Beta.Messages.BetaTool.InputSchema,
      })),
      output_config: { effort: this.options.effort },
      cache_control: { type: "ephemeral" },
      ...(this.options.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    });

    const toolCalls: ToolCall[] = [];
    const text: string[] = [];
    for (const block of response.content) {
      if (block.type === "text") text.push(block.text);
      if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }

    return {
      text: text.join("\n").trim(),
      toolCalls,
      stopReason: mapStopReason(response.stop_reason),
      raw: response.content,
    };
  }
}
