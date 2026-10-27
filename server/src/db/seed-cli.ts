import path from "node:path";
import { loadConfig } from "../config.js";
import { openDatabase } from "./client.js";
import { seed } from "./seed.js";

const config = loadConfig();
const database = await openDatabase({
  url: config.DATABASE_URL,
  pgliteDataDir: config.PGLITE_DATA_DIR,
  migrationsFolder: path.join(config.serverRoot, "drizzle"),
});
await database.migrate();
await seed(database.db);
await database.close();
console.log(`Seeded loan schemes (${database.kind}).`);
