import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { AgentEvent, AgentStatusResponse } from "@goldloan/shared";
import { MAX_USER_MESSAGE_LENGTH, type LoanAssistAgent } from "../agent/agent.js";
import { AppError } from "../errors.js";
import { parseOrThrow } from "../http.js";
import type { Logger } from "../logger.js";

const chatSchema = z.object({
  sessionId: z.string().uuid({ error: "sessionId must be a UUID" }).optional(),
  message: z
    .string({ error: "message is required" })
    .trim()
    .min(1, { error: "Type a message first" })
    .max(MAX_USER_MESSAGE_LENGTH, { error: `Keep messages under ${MAX_USER_MESSAGE_LENGTH} characters` }),
});

const confirmSchema = z.object({
  decision: z.enum(["confirm", "cancel"], { error: "decision must be confirm or cancel" }),
});

const uuid = z.string().uuid({ error: "Must be a UUID" });

export function agentRouter(agent: LoanAssistAgent, chatLimiter: RequestHandler, logger: Logger): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    const body: AgentStatusResponse = {
      available: agent.available,
      ...agent.providerInfo,
      ...(agent.available ? {} : { reason: "No AI provider configured (set OPENAI_API_KEY, ANTHROPIC_API_KEY, or LLM_PROVIDER=ollama)." }),
    };
    res.json(body);
  });

  /**
   * POST /agent/chat. With `Accept: text/event-stream` it streams tool-status events
   * (for "Calculating quote…" chips) as Server-Sent Events; otherwise it returns one JSON body.
   */
  router.post("/chat", chatLimiter, async (req, res) => {
    const { sessionId, message } = parseOrThrow(chatSchema, req.body);
    const wantsStream = (req.get("accept") ?? "").includes("text/event-stream");

    if (!wantsStream) {
      res.json(await agent.chat(sessionId, message));
      return;
    }

    if (!agent.available) {
      // Fail before opening the stream so the client sees a normal JSON error.
      await agent.chat(sessionId, message);
      return;
    }

    res.status(200);
    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    let open = true;
    res.on("close", () => {
      open = false;
    });
    const send = (event: AgentEvent) => {
      if (open) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    try {
      await agent.chat(sessionId, message, send);
    } catch (error) {
      if (error instanceof AppError) {
        send({ type: "error", code: error.code, message: error.message });
      } else {
        logger.error("agent turn failed", {
          requestId: res.locals.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
        send({
          type: "error",
          code: "AGENT_ERROR",
          message: "Loan Assist hit a problem answering that. Please try again in a moment.",
        });
      }
    } finally {
      res.end();
    }
  });

  router.post("/sessions/:sessionId/confirmations/:confirmationId", async (req, res) => {
    const sessionId = parseOrThrow(uuid, req.params.sessionId, "sessionId");
    const confirmationId = parseOrThrow(uuid, req.params.confirmationId, "confirmationId");
    const { decision } = parseOrThrow(confirmSchema, req.body);
    const result = await agent.resolveConfirmation(sessionId, confirmationId, decision);
    res.status(result.status).json(result.body);
  });

  return router;
}
