# AI_LOG

## Tools used

| Tool | Used for |
|---|---|
| **Claude Code** (Claude Opus 5.5) | Scaffolding the monorepo, the Express API, the Drizzle schema and migration, the agent loop, the React UI, tests and docs. Also drove a browser to click through the form, chat and admin views at desktop and 375 px. |
| **OpenAI** (`gpt-6.1-terra`, Responses API) | The model behind Loan Assist at runtime. Configurable; Anthropic Claude and Ollama `qwen2.5:7b-instruct` (free, local) also work. |

Everything the AI wrote was checked: by tests that assert the brief's numbers (cases 1–8), by running the real server and curling every endpoint, by running the full suite on a real PostgreSQL server as well as PGlite, and by mutation-testing the concurrency lock (removing it on purpose to confirm a test fails).

## Two exact prompts

> ✏️ **Fill these in with the prompts you actually typed.** The rubric asks for *exact* prompts, so don't submit paraphrases as if they were yours. The examples below show the level of specificity that works well; replace them with your own wording.

**Validation (example)**

```
In packages/shared, write one Zod 4 schema for a gold-loan lead that the API, the React form
and the agent's tools will all import. Rules: fullName 2–60 letters and spaces (trim, collapse
inner spaces); mobileNumber /^[6-9]\d{9}$/ as a string; grossWeightGrams and netWeightGrams
numbers > 0 and ≤ 1000 with at most 3 decimals; net ≤ gross reported on netWeightGrams;
karat exactly 18, 22 or 24; planId non-empty. Export a toFieldErrors() that turns issues into
[{ field, message }] with one message per field. The net ≤ gross check must still run when
an unrelated field like the name is invalid.
```

**Agent tools (example)**

```
Build the Loan Assist tool layer: get_loan_schemes, calculate_quote(netWeightGrams,
grossWeightGrams, karat), check_existing_application(mobileNumber), submit_application(payload).
Generate each input_schema from the same Zod schema the REST API uses, and re-validate every
call with it; on failure return { ok:false, error:{ code, fields } } to the model instead of
throwing. submit_application must NOT create a lead: it stores a pending confirmation and returns
AWAITING_USER_CONFIRMATION, and only a POST from the UI's Confirm button may call
LeadService.create, with an idempotency key. Add a guard that rejects any number in the final
reply that does not appear in a tool result.
```

## Where the AI got it wrong, how it was caught, and the test that now catches it

### 1. A concurrency test that passed with the lock removed (the main one)

**What the AI produced.** For brief case #8 ("2 parallel requests, same new mobile → exactly one 201 and one 409"), the AI wrote an advisory-lock transaction in `LeadService.create` and a Supertest test firing two parallel `POST /leads`. The test was green on PGlite and on PostgreSQL.

**How it was spotted.** PGlite runs everything on one connection, so a green test there proves nothing about races. To check the test itself, the lock was deliberately deleted and the suite re-run on a real PostgreSQL server (`TEST_DATABASE_URL`). **The test still passed**, three runs in a row. A 20-request HTTP burst also still passed. Calling the service directly with 20 concurrent creates and no lock inserted **5 leads**. So the race was real, and the HTTP tests were staggered enough by Supertest's per-request server start-up that they never hit it.

**Fix / test now catching it.** A service-level test, `tests/api/leads.test.ts`: *"the service layer itself is race-free (20 concurrent creates, one lead)"*. With the lock removed it fails on PostgreSQL; with the lock it passes. CI runs the suite against a PostgreSQL service container so this check actually runs. The HTTP tests were kept but re-labelled as end-to-end sanity checks, not race proofs.

### 2. Smaller ones caught along the way

| Mistake | Caught by | Now guarded by |
|---|---|---|
| The 24K purity button said **"99.9%"** while the maths uses 24/24 = **100%**, so the UI contradicted the calculation | Clicking through the form in the browser | Label fixed to the formula's value |
| `npm run dev` put the API on port **5173** whenever the shell exported `PORT` (the API read the global `PORT`), so the Vite proxy got `ECONNREFUSED` and every quote failed with a 502 | Running the app through a launcher that sets `PORT` | `scripts/dev.mjs` pins the API to `API_PORT` (default 4000) and passes the proxy target to Vite |
| A first draft of the animated loan figure wrote `textContent` into a span React also rendered children into, so React and the animation fought over the same DOM text node | Code review before running it | Digits now go into a dedicated span React never renders children into |
| With Zod's default `superRefine`, a cross-field check is **skipped** when any other field fails, so "net > gross" wouldn't show if the name was also wrong | Reading Zod 4's docs on check abort rules | `.refine(..., { when })` plus a test: *"reports the net > gross rule alongside unrelated field errors"* |
