import { randomUUID } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { createApp, type AppContext } from "../src/app.js";
import type { LlmProvider } from "../src/agent/types.js";
import { loadConfig } from "../src/config.js";
import { openDatabase, type Database } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { createLogger } from "../src/logger.js";

export interface TestContext extends AppContext {
  database: Database;
  /** Every log line, exactly as production would write it (after masking). */
  logs: string[];
  close(): Promise<void>;
}

export async function createTestContext(
  options: { provider?: LlmProvider | null; env?: Record<string, unknown> } = {},
): Promise<TestContext> {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "",
    LEADS_RATE_LIMIT_PER_MINUTE: 10_000,
    AGENT_RATE_LIMIT_PER_MINUTE: 10_000,
    ...options.env,
  });
  const migrationsFolder = path.join(config.serverRoot, "drizzle");
  const testDb = process.env.TEST_DATABASE_URL ? await createScratchPostgres(process.env.TEST_DATABASE_URL) : null;
  const database = await openDatabase(
    testDb ? { url: testDb.url, migrationsFolder } : { pgliteDataDir: "memory://", migrationsFolder },
  );
  await database.migrate();
  await seed(database.db);

  const logs: string[] = [];
  const logger = createLogger("debug", (line) => logs.push(line));
  const context = createApp({ config, db: database.db, logger, provider: options.provider ?? null });
  return {
    ...context,
    database,
    logs,
    close: async () => {
      await database.close();
      await testDb?.drop();
    },
  };
}

/**
 * With TEST_DATABASE_URL set (CI, or a local Postgres), every test context gets its own
 * throwaway database on a real server, so concurrency tests run over real separate connections.
 */
async function createScratchPostgres(adminUrl: string): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `goldloan_test_${randomUUID().replace(/-/g, "")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await client.end();
    },
  };
}

export const validLead = (overrides: Record<string, unknown> = {}) => ({
  fullName: "Ravi Kumar",
  mobileNumber: "9876543210",
  grossWeightGrams: 48,
  netWeightGrams: 45,
  karat: 22,
  planId: "PLAN_EMI_01",
  ...overrides,
});
