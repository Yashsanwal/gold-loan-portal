import path from "node:path";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { seed } from "./db/seed.js";
import { createLogger } from "./logger.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);

const database = await openDatabase({
  url: config.DATABASE_URL,
  pgliteDataDir: config.PGLITE_DATA_DIR,
  migrationsFolder: path.join(config.serverRoot, "drizzle"),
});

if (config.AUTO_MIGRATE) {
  await database.migrate();
  await seed(database.db);
}

const { app, agent } = createApp({ config, db: database.db, logger });

const server = app.listen(config.PORT, () => {
  logger.info("api listening", {
    url: `http://localhost:${config.PORT}`,
    database: database.kind,
    agent: agent.providerInfo,
  });
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });
  server.close();
  await database.close().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled rejection", { error: reason instanceof Error ? reason.message : String(reason) });
});
