import {
  formatGrams,
  formatInr,
  type AgentChatResponse,
  type AgentConfirmResponse,
  type AgentEvent,
  type ConfirmationSummary,
} from "@goldloan/shared";
import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { Services } from "../services/index.js";
import { findUngroundedNumbers } from "./grounding.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import type { AgentSession, SessionStore } from "./session-store.js";
import { TOOL_LABELS, TOOL_SPECS, executeTool } from "./tools.js";
import type { ChatMessage, LlmProvider, ModelTurn } from "./types.js";

const MAX_MODEL_CALLS_PER_TURN = 8;
const MAX_GROUNDING_RETRIES = 1;
export const MAX_USER_MESSAGE_LENGTH = 2000;

const REFUSAL_REPLY =
  "I can only help with gold-loan quotes and applications here. Tell me your gold's weight and karat and I'll get you a quote.";
const LOOP_LIMIT_REPLY =
  "Sorry, I couldn't finish that. Could you tell me again what you'd like to do with your gold loan?";

export type ConfirmResult =
  | { status: 201; body: Extract<AgentConfirmResponse, { outcome: "SUBMITTED" }> }
  | { status: 200; body: Extract<AgentConfirmResponse, { outcome: "CANCELLED" }> }
  | { status: 409; body: import("@goldloan/shared").ApiErrorBody };

/** Every text the model may legitimately take a number from. */
function groundingSources(messages: ChatMessage[]): string[] {
  const sources = [SYSTEM_PROMPT];
  for (const message of messages) {
    if (message.role === "user") sources.push(message.content);
    if (message.role === "tool_results") for (const result of message.results) sources.push(result.content);
  }
  return sources;
}

/** Deterministic fallback when the model keeps stating figures no tool produced. */
function lastQuoteSummary(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "tool_results") continue;
    for (const result of message.results) {
      if (result.name !== "calculate_quote" || result.isError) continue;
      const quote = JSON.parse(result.content) as {
        pureGoldGrams: number;
        goldValue: number;
        plans: { planName: string; eligibleLoan: number; appliedLtvPercent: number }[];
      };
      const plans = quote.plans
        .map((p) => `• ${p.planName}: up to ${formatInr(p.eligibleLoan)} (${p.appliedLtvPercent}% LTV)`)
        .join("\n");
      return `Here is the quote exactly as our calculator produced it:\nPure gold ${formatGrams(quote.pureGoldGrams)}, gold value ${formatInr(quote.goldValue)}.\n${plans}\nThis is a preliminary offer, subject to verification of the gold.`;
    }
  }
  return null;
}

export class LoanAssistAgent {
  constructor(
    private readonly provider: LlmProvider | null,
    private readonly services: Services,
    private readonly sessions: SessionStore,
    private readonly logger: Logger,
  ) {}

  get available(): boolean {
    return this.provider !== null;
  }

  get providerInfo(): { provider: string; model: string | null } {
    return { provider: this.provider?.name ?? "none", model: this.provider?.model ?? null };
  }

  /**
   * One user turn. The turn runs on a copy of the history and is committed only if it
   * completes, so a provider failure never leaves a half-finished tool exchange behind.
   */
  async chat(
    sessionId: string | undefined,
    userText: string,
    emit: (event: AgentEvent) => void = () => {},
  ): Promise<AgentChatResponse> {
    if (!this.provider) {
      throw new AppError(
        503,
        "AGENT_UNAVAILABLE",
        "Loan Assist is offline because no AI provider is configured. You can still apply with the form.",
      );
    }
    const provider = this.provider;
    const session = this.sessions.getOrCreate(sessionId);
    if (session.busy) {
      throw new AppError(409, "AGENT_BUSY", "Still working on your previous message. Please wait a moment.");
    }

    session.busy = true;
    const events: AgentEvent[] = [];
    let confirmation: ConfirmationSummary | null = null;
    const record = (event: AgentEvent) => {
      events.push(event);
      emit(event);
    };
    record({ type: "session", sessionId: session.id });

    try {
      const draft = [...session.messages];
      const notices = session.notices.map((notice) => `[Portal notice: ${notice}]`);
      draft.push({ role: "user", content: [...notices, userText].join("\n") });

      const reply = await this.runLoop(provider, session, draft, record, (summary) => {
        confirmation = summary;
      });

      session.messages = draft;
      session.notices = [];
      record({ type: "message", text: reply });
      record({ type: "done" });
      return { sessionId: session.id, reply, events, confirmation };
    } finally {
      session.busy = false;
      session.lastActiveAt = Date.now();
    }
  }

  private async runLoop(
    provider: LlmProvider,
    session: AgentSession,
    draft: ChatMessage[],
    record: (event: AgentEvent) => void,
    onConfirmation: (summary: ConfirmationSummary) => void,
  ): Promise<string> {
    let groundingRetries = 0;

    for (let call = 0; call < MAX_MODEL_CALLS_PER_TURN; call++) {
      const turn: ModelTurn = await provider.complete({ system: SYSTEM_PROMPT, messages: draft, tools: TOOL_SPECS });
      draft.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls, raw: turn.raw, provider: provider.name });

      if (turn.stopReason === "refusal") return REFUSAL_REPLY;

      if (turn.toolCalls.length > 0) {
        const results = [];
        for (const toolCall of turn.toolCalls) {
          record({ type: "tool_start", id: toolCall.id, name: toolCall.name, label: TOOL_LABELS[toolCall.name] ?? "Working…" });
          const { result, outcome } = await executeTool(toolCall, {
            services: this.services,
            session,
            onConfirmation: (summary) => {
              onConfirmation(summary);
              record({ type: "confirmation_required", confirmation: summary });
            },
          });
          this.logger.info("agent tool call", {
            sessionId: session.id,
            tool: toolCall.name,
            ok: outcome.ok,
            summary: outcome.summary,
          });
          record({ type: "tool_end", id: toolCall.id, name: toolCall.name, ok: outcome.ok, summary: outcome.summary });
          results.push(result);
        }
        draft.push({ role: "tool_results", results });
        continue;
      }

      const reply = turn.text.trim();
      const ungrounded = findUngroundedNumbers(reply, groundingSources(draft));
      if (ungrounded.length === 0) return reply || LOOP_LIMIT_REPLY;

      this.logger.warn("agent reply had ungrounded numbers", { sessionId: session.id, numbers: ungrounded });
      if (groundingRetries < MAX_GROUNDING_RETRIES) {
        groundingRetries++;
        draft.push({
          role: "user",
          content: `[Accuracy check: your last reply contained figures that no tool returned: ${ungrounded.join(", ")}. You must not calculate. Rewrite the reply using only figures copied exactly from tool results, calling a tool if you need one. Do not mention this check.]`,
        });
        continue;
      }
      return lastQuoteSummary(draft) ?? "I can only share figures from our calculator. Tell me your gold's weight and karat and I'll calculate a quote.";
    }
    return LOOP_LIMIT_REPLY;
  }

  /** The UI's Confirm / Cancel button. This is the only path by which the agent files a lead. */
  async resolveConfirmation(
    sessionId: string,
    confirmationId: string,
    decision: "confirm" | "cancel",
  ): Promise<ConfirmResult> {
    const session = this.sessions.get(sessionId);
    const pending = session?.pending.get(confirmationId);
    if (!session || !pending) {
      throw new AppError(404, "CONFIRMATION_NOT_FOUND", "This confirmation has expired. Ask Loan Assist to prepare it again.");
    }
    session.lastActiveAt = Date.now();

    if (decision === "cancel") {
      if (pending.state === "CONFIRMED") {
        throw new AppError(409, "CONFIRMATION_CLOSED", "This application was already submitted.");
      }
      if (pending.state === "OPEN") {
        pending.state = "CANCELLED";
        session.notices.push("The applicant pressed Cancel. Nothing was filed.");
      }
      return { status: 200, body: { outcome: "CANCELLED" } };
    }

    if (pending.state === "CANCELLED" || pending.state === "SUPERSEDED") {
      throw new AppError(
        409,
        "CONFIRMATION_CLOSED",
        pending.state === "CANCELLED"
          ? "You cancelled this application. Ask Loan Assist to prepare a new one."
          : "These details were replaced by a newer summary. Please confirm the latest card.",
      );
    }

    // Same service, same validation and maths as the form; the key makes double-clicks safe.
    const result = await this.services.leads.create(pending.request, {
      source: "AGENT",
      idempotencyKey: `agent:${confirmationId}`,
    });

    if (result.status === 201) {
      if (pending.state === "OPEN") {
        pending.state = "CONFIRMED";
        session.notices.push(
          `The applicant pressed Confirm. Application ${result.body.applicationId} was submitted with status SUBMITTED.`,
        );
      }
      return {
        status: 201,
        body: { outcome: "SUBMITTED", applicationId: result.body.applicationId, createdAt: result.body.createdAt, lead: result.body.lead },
      };
    }

    if (pending.state === "OPEN") {
      pending.state = "CANCELLED";
      const id = String(result.body.error.details?.applicationId ?? "");
      session.notices.push(`Submission was blocked: this mobile already has application ${id} from the last 7 days.`);
    }
    return { status: 409, body: result.body };
  }
}
