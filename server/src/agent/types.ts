/**
 * Provider-neutral conversation model. The agent loop, tools and guardrails only see these
 * types; each LLM provider translates them to its own wire format.
 */

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  /** JSON string returned to the model. */
  content: string;
  isError: boolean;
}

export type ChatMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      text: string;
      toolCalls: ToolCall[];
      /** Provider-native content (e.g. Anthropic blocks incl. thinking), replayed unchanged. */
      raw?: unknown;
      provider?: string;
    }
  | { role: "tool_results"; results: ToolResult[] };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  raw?: unknown;
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<ModelTurn>;
}
