import { randomUUID } from "node:crypto";
import type { ConfirmationSummary, LeadRequest } from "@goldloan/shared";
import type { ChatMessage } from "./types.js";

export type ConfirmationState = "OPEN" | "CONFIRMED" | "CANCELLED" | "SUPERSEDED";

export interface PendingConfirmation {
  summary: ConfirmationSummary;
  /** The validated payload the user saw on the card; this exact object is what gets filed. */
  request: LeadRequest;
  state: ConfirmationState;
  createdAt: Date;
}

export interface AgentSession {
  id: string;
  messages: ChatMessage[];
  pending: Map<string, PendingConfirmation>;
  /** Portal events (confirm / cancel) to tell the model about on the next user turn. */
  notices: string[];
  busy: boolean;
  lastActiveAt: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * In-memory sessions with idle expiry and an upper bound (oldest evicted first). Conversation
 * state lives on the server so a client cannot forge tool results or confirmation state.
 * Redis would replace this for multi-instance deployments.
 */
export class SessionStore {
  private readonly sessions = new Map<string, AgentSession>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxSessions: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(id: string | undefined): AgentSession | undefined {
    if (!id || !UUID_PATTERN.test(id)) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (this.now() - session.lastActiveAt > this.ttlMs) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  getOrCreate(id: string | undefined): AgentSession {
    const existing = this.get(id);
    if (existing) {
      existing.lastActiveAt = this.now();
      // Re-insert to keep Map order = least recently used first.
      this.sessions.delete(existing.id);
      this.sessions.set(existing.id, existing);
      return existing;
    }
    this.evict();
    const session: AgentSession = {
      id: randomUUID(),
      messages: [],
      pending: new Map(),
      notices: [],
      busy: false,
      lastActiveAt: this.now(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get size(): number {
    return this.sessions.size;
  }

  private evict(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, session] of this.sessions) {
      if (session.lastActiveAt < cutoff && !session.busy) this.sessions.delete(id);
    }
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }
}
