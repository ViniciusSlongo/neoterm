import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { DATABASE_URL, REPO_ROOT } from "../config.ts";
import * as schema from "./schema.ts";

export function connect(url: string = DATABASE_URL) {
  const sql = postgres(url, { max: 5, onnotice: () => {} });
  return { sql, db: drizzle(sql, { schema }) };
}

export type Database = ReturnType<typeof connect>["db"];

export async function applyMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: join(REPO_ROOT, "drizzle") });
}

/** Espera o Postgres aceitar conexões, que logo depois de `docker compose up` ainda demora. */
export async function waitForDatabase(
  url: string = DATABASE_URL,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const sql = postgres(url, { max: 1, connect_timeout: 2, onnotice: () => {} });
    try {
      await sql`select 1`;
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
  throw new Error(
    `o Postgres não respondeu em ${timeoutMs / 1000} s: ${errorMessage(lastError)}`,
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
