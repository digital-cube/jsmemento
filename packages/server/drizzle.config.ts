import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL ?? "postgresql://jsmemento:jsmemento@localhost:5432/jsmemento";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
});
