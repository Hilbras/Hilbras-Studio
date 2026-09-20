import path from "node:path";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DB_FILE_NAME ??
      path.join(process.cwd(), "data", "hilbras.db"),
  },
});