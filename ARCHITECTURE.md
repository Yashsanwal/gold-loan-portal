# Architecture

## Components

```
┌──────────────────────── web (React, Vite) ────────────────────────┐
│ Apply (3 steps, live quote) · Loan Assist (SSE chat) · Admin      │
│ validates with @goldloan/shared before calling the API            │
└───────────────┬───────────────────────────────────────────────────┘
                │ /api/v1  (JSON, SSE for chat)
┌───────────────▼──────────────── server (Express 5) ───────────────┐
│ routes/api.ts         routes/agent.ts                             │
│   │ parseOrThrow(Zod)    │ LoanAssistAgent ── LlmProvider         │
│   │                      │   tools.ts (Zod-validated)   (OpenAI / │
│   ▼                      ▼                               Ollama)  │
│ services: SchemeService · GoldRateService · QuoteService ·        │
│           LeadService.create  ← the ONLY way a lead is written    │
│   │                                                               │
│ Drizzle ── PostgreSQL (DATABASE_URL)  or  PGlite (default)        │
└───────────────────────────────────────────────────────────────────┘
```

`@goldloan/shared` holds the money maths, the Zod schemas and the response types. The server, the web app and the agent's tool definitions all import it, so there is exactly one definition of a valid application and of how a loan is priced.

## Data model

| Table | Key columns |
|---|---|
| `loan_schemes` | `id`, `annual_interest_rate_bps`, `tenure_months`, `max_ltv_bps` (`CHECK ≤ 7500`), `repayment_type`, `is_active` |
| `leads` | `application_id` (`'GL-' \|\| nextval(seq)`, unique), name, mobile (`CHECK ~ '^[6-9][0-9]{9}$'`), weights in **mg**, karat (`CHECK IN (18,22,24)`), `rate_24k_paise_per_gram`, `pure_gold_mg`, `gold_value_paise`, `applied_ltv_bps`, `eligible_loan_paise`, `status`, `source` (`FORM`/`AGENT`), index `(mobile_number, created_at desc)` |
| `lead_audit_log` | `lead_id`, `from_status`, `to_status`, `note`, `actor`, `created_at` |
| `idempotency_keys` | `key` (PK), `request_hash`, `response_status`, `response_body` (jsonb), `created_at` |

Each lead stores the rate and LTV it was priced at, so later rate changes never rewrite history.

## Creating a lead (form and agent)

```
validate (Zod) ─► plan active? (404) ─► price with exact maths
BEGIN
  [Idempotency-Key] pg_advisory_xact_lock(1, hashtext(key))
                    stored? same hash → replay · different hash → 422
  pg_advisory_xact_lock(2, hashtext(mobile))     ← serialises same-mobile requests
  recent lead for mobile in last 7 days? → 409 body
  else INSERT lead + audit row → 201 body
  [Idempotency-Key] INSERT idempotency row (201 or 409 body)
COMMIT
```

The second request for a mobile waits on the advisory lock, and under READ COMMITTED its duplicate check then sees the first request's committed row. Without the lock, 5 of 20 concurrent creates were inserted on PostgreSQL; a regression test now covers it (`tests/api/leads.test.ts`, "the service layer itself is race-free").

## Agent turn

1. `chat(sessionId, text)` loads the server-side session (TTL, LRU bound) and works on a **copy** of its history. Portal notices (Confirm/Cancel outcomes) are prepended to the user message.
2. Loop of up to 8 model calls: each tool call is validated with the shared Zod schema and executed against the services; results go back as JSON (`is_error` on failure). Tool start/end events stream to the browser.
3. On a final text reply, the **grounding guard** extracts every number and checks it against tool results, user text and the system prompt. A miss triggers one "accuracy check" retry; a second miss swaps in a deterministic summary of the last quote.
4. Only on success is the history committed.

`submit_application` creates a **pending confirmation** (validated payload + priced summary) and returns `AWAITING_USER_CONFIRMATION`. The lead is filed only by `POST /agent/sessions/:sid/confirmations/:cid {decision:"confirm"}`, which calls `LeadService.create(..., { source: "AGENT", idempotencyKey: "agent:<cid>" })`.

## Error handling

`AppError(status, code, message, fields, details)` for expected failures; body-parser errors map to 400/413/415; anything else is logged with the request id and returned as a generic 500 JSON. Logs are JSON lines, and every line is passed through a mobile-number masker before it is written.

## Configuration

`server/src/config.ts` validates the environment with Zod at boot and fails fast with a readable list of problems. The LLM provider is chosen from config (`openai` or `anthropic` when a key exists, `ollama`, or `none`), and tests and evals inject their own provider.
