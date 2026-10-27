import fs from "node:fs";
import path from "node:path";
import express, { type Express } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { AnthropicProvider } from "./agent/providers/anthropic.js";
import { OllamaProvider } from "./agent/providers/ollama.js";
import { OpenAIProvider } from "./agent/providers/openai.js";
import { LoanAssistAgent } from "./agent/agent.js";
import { SessionStore } from "./agent/session-store.js";
import type { LlmProvider } from "./agent/types.js";
import type { AppConfig } from "./config.js";
import type { AppDb } from "./db/client.js";
import { errorBody } from "./errors.js";
import { accessLog, errorHandler, notFoundRoute, requestId } from "./http.js";
import type { Logger } from "./logger.js";
import { agentRouter } from "./routes/agent.js";
import { apiRouter } from "./routes/api.js";
import { createServices, type Services } from "./services/index.js";

export interface AppDependencies {
  config: AppConfig;
  db: AppDb;
  logger: Logger;
  /** Overrides the provider chosen from config (tests and evals inject scripted models). */
  provider?: LlmProvider | null;
}

export interface AppContext {
  app: Express;
  services: Services;
  agent: LoanAssistAgent;
}

export function createProvider(config: AppConfig): LlmProvider | null {
  switch (config.llmProvider) {
    case "openai":
      if (!config.OPENAI_API_KEY) return null;
      return new OpenAIProvider({
        apiKey: config.OPENAI_API_KEY,
        model: config.OPENAI_MODEL,
        reasoningEffort: config.OPENAI_REASONING_EFFORT,
      });
    case "anthropic":
      if (!config.ANTHROPIC_API_KEY) return null;
      return new AnthropicProvider({
        apiKey: config.ANTHROPIC_API_KEY,
        model: config.ANTHROPIC_MODEL,
        effort: config.ANTHROPIC_EFFORT,
        fallbacks: config.ANTHROPIC_FALLBACKS,
      });
    case "ollama":
      return new OllamaProvider(config.OLLAMA_BASE_URL, config.OLLAMA_MODEL);
    default:
      return null;
  }
}

function limiter(perMinute: number, message: string) {
  return rateLimit({
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json(errorBody("RATE_LIMITED", message));
    },
  });
}

export function createApp({ config, db, logger, provider }: AppDependencies): AppContext {
  const services = createServices(db, config);
  const sessions = new SessionStore(config.AGENT_SESSION_TTL_MINUTES * 60_000, config.AGENT_MAX_SESSIONS);
  const agent = new LoanAssistAgent(provider === undefined ? createProvider(config) : provider, services, sessions, logger);

  const app = express();
  app.disable("x-powered-by");
  if (config.TRUST_PROXY) app.set("trust proxy", 1);

  app.use(requestId);
  app.use(accessLog(logger));
  app.use(helmet({ contentSecurityPolicy: config.NODE_ENV === "production" ? undefined : false }));
  if (config.CORS_ORIGIN) {
    const origin = config.CORS_ORIGIN;
    app.use((req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key, Accept");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
      next();
    });
  }
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const leadsLimiter = limiter(config.LEADS_RATE_LIMIT_PER_MINUTE, "Too many applications from this device. Please wait a minute.");
  const chatLimiter = limiter(config.AGENT_RATE_LIMIT_PER_MINUTE, "You're sending messages quickly. Please wait a moment.");

  app.use("/api/v1", apiRouter(services, leadsLimiter));
  app.use("/api/v1/agent", agentRouter(agent, chatLimiter, logger));
  app.use("/api", notFoundRoute);

  // In production the API also serves the built SPA (single container deploys).
  const webDist = path.join(config.repoRoot, "web", "dist");
  if (config.NODE_ENV === "production" && fs.existsSync(path.join(webDist, "index.html"))) {
    app.use(express.static(webDist, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  app.use(notFoundRoute);
  app.use(errorHandler(logger));
  return { app, services, agent };
}
