import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.NEOTERM_DATABASE_URL ??
      "postgres://neoterm:neoterm@127.0.0.1:5433/neoterm",
  },
});
