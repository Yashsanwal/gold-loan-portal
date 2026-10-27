import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(serverRoot, "..");

// Root .env first (documented location), then server/.env for overrides.
loadDotenv({ path: path.join(repoRoot, ".env"), quiet: true });
loadDotenv({ path: path.join(serverRoot, ".env"), quiet: true });

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const bool = (fallback: boolean) =>
  z.preprocess(
    (value) => (emptyToUndefined(value) === undefined ? fallback : value),
    z
      .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
      .transform((value) => value === true || value === "true" || value === "1"),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),

  /** Postgres connection string. When unset, an embedded PGlite (real Postgres in WASM) is used. */
  DATABASE_URL: optionalString,
  PGLITE_DATA_DIR: z.string().default(path.join(serverRoot, ".data", "pglite")),
  AUTO_MIGRATE: bool(true),

  GOLD_RATE_24K_PER_GRAM: z.coerce.number().positive().max(1_000_000).default(7000),
  GOLD_RATE_CACHE_SECONDS: z.coerce.number().int().min(0).default(300),
  DUPLICATE_WINDOW_DAYS: z.coerce.number().int().min(1).default(7),
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).default(24),

  LEADS_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  AGENT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  TRUST_PROXY: bool(false),
  CORS_ORIGIN: optionalString,

  /** openai | anthropic | ollama | none. Defaults to whichever API key is present (OpenAI first), else none. */
  LLM_PROVIDER: z.preprocess(emptyToUndefined, z.enum(["openai", "anthropic", "ollama", "none"]).optional()),
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: z.string().default("gpt-6.1-terra"),
  OPENAI_REASONING_EFFORT: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).default("low"),
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  /** Server-side refusal fallback (beta). Set false on gateways that reject beta headers. */
  ANTHROPIC_FALLBACKS: bool(true),
  OLLAMA_BASE_URL: z.string().url().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().default("qwen2.5:7b-instruct"),
  AGENT_SESSION_TTL_MINUTES: z.coerce.number().int().min(1).default(60),
  AGENT_MAX_SESSIONS: z.coerce.number().int().min(1).default(1000),
});

export type AppConfig = z.infer<typeof envSchema> & {
  serverRoot: string;
  repoRoot: string;
  llmProvider: "openai" | "anthropic" | "ollama" | "none";
};

export function loadConfig(overrides: Record<string, unknown> = {}): AppConfig {
  const parsed = envSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  const env = parsed.data;
  const llmProvider =
    env.LLM_PROVIDER ?? (env.OPENAI_API_KEY ? "openai" : env.ANTHROPIC_API_KEY ? "anthropic" : "none");
  return { ...env, serverRoot, repoRoot, llmProvider };
}
