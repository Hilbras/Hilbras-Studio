import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });

/** Close the process-wide pool during graceful shutdown or integration teardown. */
export async function closeDb(): Promise<void> {
  await pool.end();
}

export { schema };
