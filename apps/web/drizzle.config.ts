import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://sendsprite:sendsprite@localhost:5432/sendsprite",
  },
  strict: true,
  verbose: true,
});
