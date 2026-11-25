import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { migrate } from "drizzle-orm/sqlite-proxy/migrator";
import { DATABASE_FILE, REPO_ROOT } from "../config.ts";
import * as schema from "./schema.ts";

/*
 * SQLite pelo `node:sqlite` que vem no Node: um arquivo, nada para instalar ou compilar. Só o motor
 * abre o banco (o CLI e a interface falam com o motor por HTTP), então uma conexão basta. Ela é
 * síncrona: cada consulta roda inteira antes da próxima, o que também deixa um lote (`batch`)
 * atômico sem precisar de transações intercaladas.
 */

export function connect(file: string = DATABASE_FILE) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const sqlite = new DatabaseSync(file);
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

  const execute = (sql: string, params: unknown[], method: "run" | "all" | "values" | "get") => {
    const statement = sqlite.prepare(sql);
    const values = params as (string | number | bigint | null | Uint8Array)[];
    if (method === "run") {
      statement.run(...values);
      return { rows: [] as unknown[] };
    }
    statement.setReturnArrays(true);
    if (method === "get") return { rows: (statement.get(...values) as unknown[] | undefined) ?? [] };
    return { rows: statement.all(...values) as unknown[] };
  };

  const db = drizzle(
    async (sql, params, method) => execute(sql, params, method),
    async (batch) => {
      sqlite.exec("BEGIN");
      try {
        const results = batch.map((query) => execute(query.sql, query.params, query.method));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    { schema },
  );
  return { sqlite, db, close: () => sqlite.close() };
}

export type Database = ReturnType<typeof connect>["db"];

export async function applyMigrations(connection: ReturnType<typeof connect>): Promise<void> {
  await migrate(
    connection.db,
    async (queries) => {
      connection.sqlite.exec("BEGIN");
      try {
        for (const query of queries) connection.sqlite.exec(query);
        connection.sqlite.exec("COMMIT");
      } catch (error) {
        connection.sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    { migrationsFolder: join(REPO_ROOT, "drizzle") },
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
