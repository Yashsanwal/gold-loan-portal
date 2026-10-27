import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema.js";

export type AppDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Database {
  db: AppDb;
  kind: "postgres" | "pglite";
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  /** postgres://… connection string. Takes precedence over PGlite. */
  url?: string;
  /** PGlite data directory, or "memory://" for an in-memory database (tests). */
  pgliteDataDir?: string;
  migrationsFolder: string;
}

/**
 * Real PostgreSQL when DATABASE_URL is set; otherwise PGlite, which is Postgres compiled to
 * WASM. Same SQL, same migrations, same advisory locks, and `npm run dev` needs no Docker.
 */
export async function openDatabase(options: DatabaseOptions): Promise<Database> {
  if (options.url) {
    const pool = new pg.Pool({ connectionString: options.url, max: 10 });
    const db = drizzlePg(pool, { schema }) as unknown as AppDb;
    return {
      db,
      kind: "postgres",
      migrate: () => migratePg(drizzlePg(pool), { migrationsFolder: options.migrationsFolder }),
      close: () => pool.end(),
    };
  }

  const dataDir = options.pgliteDataDir ?? "memory://";
  if (!dataDir.startsWith("memory://")) fs.mkdirSync(path.resolve(dataDir), { recursive: true });
  const client = await PGlite.create(dataDir);
  const db = drizzlePglite(client, { schema }) as unknown as AppDb;
  return {
    db,
    kind: "pglite",
    migrate: () => migratePglite(drizzlePglite(client), { migrationsFolder: options.migrationsFolder }),
    close: () => client.close(),
  };
}
