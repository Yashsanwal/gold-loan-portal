import type { ChatMessage, CompletionRequest, LlmProvider, ModelTurn } from "../src/agent/types.js";

export type Step = ModelTurn | ((request: CompletionRequest) => ModelTurn);

let ids = 0;
export const toolCall = (name: string, input: unknown = {}) => ({ id: `call_${++ids}`, name, input });
export const say = (text: string): ModelTurn => ({ text, toolCalls: [], stopReason: "end_turn" });
export const use = (...calls: ReturnType<typeof toolCall>[]): ModelTurn => ({ text: "", toolCalls: calls, stopReason: "tool_use" });

/** Last tool result for a tool name, parsed. */
export function lastToolResult(messages: ChatMessage[], name: string): Record<string, unknown> | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "tool_results") continue;
    const hit = message.results.find((r) => r.name === name);
    if (hit) return JSON.parse(hit.content) as Record<string, unknown>;
  }
  return undefined;
}

/**
 * A deterministic stand-in for an LLM: replays a script of turns. Lets the tests check the
 * agent's orchestration and guardrails (validation round-trips, confirmation gate, grounding)
 * without network calls. Model *behaviour* is covered by `npm run eval` against a real model.
 */
export class ScriptedProvider implements LlmProvider {
  readonly name = "scripted";
  readonly model = "scripted-v1";
  readonly requests: CompletionRequest[] = [];
  private queue: Step[] = [];

  script(...steps: Step[]): this {
    this.queue.push(...steps);
    return this;
  }

  get remaining(): number {
    return this.queue.length;
  }

  async complete(request: CompletionRequest): Promise<ModelTurn> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const step = this.queue.shift();
    if (!step) throw new Error("ScriptedProvider ran out of steps");
    return typeof step === "function" ? step(request) : step;
  }
}
