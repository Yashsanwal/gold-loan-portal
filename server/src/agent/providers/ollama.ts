import { randomUUID } from "node:crypto";
import type { ChatMessage, CompletionRequest, LlmProvider, ModelTurn } from "../types.js";

/**
 * Free, local alternative via Ollama's native /api/chat endpoint (tool calling supported by
 * models such as qwen2.5 and llama3.1). Useful when no paid key is available.
 */

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: unknown } }[];
  tool_name?: string;
}

interface OllamaResponse {
  message?: OllamaMessage;
  done_reason?: string;
  error?: string;
}

function toOllamaMessages(system: string, messages: ChatMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") out.push({ role: "user", content: message.content });
    else if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: message.text,
        ...(message.toolCalls.length > 0
          ? { tool_calls: message.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.input ?? {} } })) }
          : {}),
      });
    } else {
      for (const result of message.results) {
        out.push({ role: "tool", tool_name: result.name, content: result.content });
      }
    }
  }
  return out;
}

export class OllamaProvider implements LlmProvider {
  readonly name = "ollama";

  constructor(
    private readonly baseUrl: string,
    readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(request: CompletionRequest): Promise<ModelTurn> {
    const response = await this.fetchImpl(new URL("/api/chat", this.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: this.model,
        stream: false,
        options: { temperature: 0 },
        messages: toOllamaMessages(request.system, request.messages),
        tools: request.tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
        })),
      }),
    });
    const body = (await response.json().catch(() => ({}))) as OllamaResponse;
    if (!response.ok || body.error) {
      throw new Error(`Ollama request failed (${response.status}): ${body.error ?? "unknown error"}`);
    }

    const message = body.message ?? { role: "assistant", content: "" };
    const toolCalls = (message.tool_calls ?? []).map((call) => ({
      id: randomUUID(),
      name: call.function.name,
      input:
        typeof call.function.arguments === "string" ? safeJson(call.function.arguments) : call.function.arguments,
    }));
    return {
      text: (message.content ?? "").trim(),
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_use" : body.done_reason === "length" ? "max_tokens" : "end_turn",
    };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { __unparseable: text };
  }
}
