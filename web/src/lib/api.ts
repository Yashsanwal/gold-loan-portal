import type {
  AgentConfirmResponse,
  AgentEvent,
  AgentStatusResponse,
  ApiErrorBody,
  CreateLeadResponse,
  FieldError,
  GoldRateResponse,
  LeadDetailResponse,
  LeadListResponse,
  LeadRequestInput,
  LeadStatus,
  LoanScheme,
  QuoteRequest,
  QuoteResponse,
} from "@goldloan/shared";

const BASE = "/api/v1";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: FieldError[] = [],
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  fieldMessage(field: string): string | undefined {
    return this.fields.find((f) => f.field === field)?.message;
  }
}

async function parseError(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
  if (body?.error) {
    return new ApiError(response.status, body.error.code, body.error.message, body.error.fields, body.error.details);
  }
  return new ApiError(response.status, "HTTP_ERROR", `The server answered with ${response.status}. Please try again.`);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "NETWORK_ERROR", "Can't reach the server. Check your connection and try again.");
  }
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as T;
}

export const api = {
  schemes: () => request<{ data: LoanScheme[] }>("/loan-schemes").then((r) => r.data),
  goldRate: () => request<GoldRateResponse>("/gold-rate"),
  quote: (input: QuoteRequest, signal?: AbortSignal) =>
    request<QuoteResponse>("/quotes", { method: "POST", body: JSON.stringify(input), signal }),
  createLead: (input: LeadRequestInput, idempotencyKey: string) =>
    request<CreateLeadResponse>("/leads", {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "Idempotency-Key": idempotencyKey },
    }),
  leads: (params: { page: number; pageSize: number; planId?: string; status?: LeadStatus }, signal?: AbortSignal) => {
    const query = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) });
    if (params.planId) query.set("planId", params.planId);
    if (params.status) query.set("status", params.status);
    return request<LeadListResponse>(`/leads?${query}`, { signal });
  },
  lead: (applicationId: string) => request<LeadDetailResponse>(`/leads/${encodeURIComponent(applicationId)}`),
  updateStatus: (applicationId: string, status: LeadStatus, note?: string) =>
    request<LeadDetailResponse>(`/leads/${encodeURIComponent(applicationId)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status, ...(note ? { note } : {}) }),
    }),
  agentStatus: () => request<AgentStatusResponse>("/agent/status"),
  resolveConfirmation: (sessionId: string, confirmationId: string, decision: "confirm" | "cancel") =>
    request<AgentConfirmResponse>(
      `/agent/sessions/${encodeURIComponent(sessionId)}/confirmations/${encodeURIComponent(confirmationId)}`,
      { method: "POST", body: JSON.stringify({ decision }) },
    ),
};

/**
 * POST /agent/chat as Server-Sent Events. EventSource can't POST, so the stream is read
 * from fetch and split on blank lines.
 */
export async function streamChat(
  body: { message: string; sessionId?: string },
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "NETWORK_ERROR", "Can't reach the server. Check your connection and try again.");
  }
  if (!response.ok) throw await parseError(response);
  if (!response.body) throw new ApiError(0, "STREAM_ERROR", "Streaming is not supported in this browser.");

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) onEvent(JSON.parse(data) as AgentEvent);
      boundary = buffer.indexOf("\n\n");
    }
  }
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
