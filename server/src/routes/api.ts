import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { LEAD_STATUSES, leadRequestSchema, quoteRequestSchema, statusUpdateSchema } from "@goldloan/shared";
import { validationError } from "../errors.js";
import { parseOrThrow } from "../http.js";
import type { Services } from "../services/index.js";
import { toGoldRateResponse } from "../services/gold-rate.js";
import { toLoanScheme } from "../services/schemes.js";

const listQuerySchema = z.object({
  page: z.coerce.number({ error: "page must be a number" }).int().min(1).default(1),
  pageSize: z.coerce.number({ error: "pageSize must be a number" }).int().min(1).max(100).default(20),
  planId: z.string().trim().min(1).max(64).optional(),
  status: z.enum(LEAD_STATUSES, { error: `status must be one of ${LEAD_STATUSES.join(", ")}` }).optional(),
});

const applicationIdSchema = z.string().regex(/^GL-\d{1,12}$/, { error: "Application ids look like GL-1042" });

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;

function readIdempotencyKey(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  if (!IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw validationError(
      [{ field: "Idempotency-Key", message: "Use 1-255 visible ASCII characters, e.g. a UUID" }],
      "Invalid Idempotency-Key header",
    );
  }
  return header;
}

export function apiRouter(services: Services, leadsWriteLimiter: RequestHandler): Router {
  const router = Router();

  router.get("/loan-schemes", async (_req, res) => {
    const schemes = await services.schemes.listActive();
    res.json({ data: schemes.map(toLoanScheme) });
  });

  router.get("/gold-rate", async (_req, res) => {
    const snapshot = await services.goldRate.current();
    const maxAge = Math.max(0, Math.floor((snapshot.cachedUntil.getTime() - Date.now()) / 1000));
    res.set("Cache-Control", `public, max-age=${maxAge}`);
    res.json(toGoldRateResponse(snapshot));
  });

  // Pure calculation: no database write.
  router.post("/quotes", async (req, res) => {
    const input = parseOrThrow(quoteRequestSchema, req.body);
    res.json(await services.quotes.quote(input));
  });

  router.post("/leads", leadsWriteLimiter, async (req, res) => {
    const idempotencyKey = readIdempotencyKey(req.get("Idempotency-Key"));
    // Unknown keys (e.g. a client-sent "eligibleLoan") are stripped; the server recomputes everything.
    const input = parseOrThrow(leadRequestSchema, req.body);
    const result = await services.leads.create(input, { source: "FORM", idempotencyKey });
    if (result.replayed) res.set("Idempotent-Replayed", "true");
    if (result.status === 201) res.location(`/api/v1/leads/${result.body.applicationId}`);
    res.status(result.status).json(result.body);
  });

  router.get("/leads", async (req, res) => {
    const query = parseOrThrow(listQuerySchema, req.query, "query");
    res.json(await services.leads.list(query));
  });

  router.get("/leads/:applicationId", async (req, res) => {
    const applicationId = parseOrThrow(applicationIdSchema, req.params.applicationId, "applicationId");
    res.json(await services.leads.get(applicationId));
  });

  router.patch("/leads/:applicationId/status", async (req, res) => {
    const applicationId = parseOrThrow(applicationIdSchema, req.params.applicationId, "applicationId");
    const update = parseOrThrow(statusUpdateSchema, req.body);
    res.json(await services.leads.updateStatus(applicationId, update, "admin"));
  });

  return router;
}
