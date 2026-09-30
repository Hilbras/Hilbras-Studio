import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * An idle client that dies takes the process down with it unless the pool has an
 * `error` listener. This is not a `pg` quirk to shrug at: the server closes idle
 * connections (a proxy timeout, a restart, a failover), and node-postgres
 * documents that an unhandled `error` on a Pool is an uncaught exception.
 *
 * Without this line, a database blip that the application would otherwise retry
 * through kills the process instead. That is exactly how it presented on CI: a
 * `57P01 terminating connection due to administrator command` surfacing as an
 * *uncaught exception* after the tests that used the pool had already passed —
 * 214/214 green, and the run still red. It also happened to fire during
 * teardown, where the container stop kills the socket by design.
 *
 * Logged rather than swallowed: a connection dying is worth seeing, and a real
 * query using that connection fails loudly and normally on its own.
 */
pool.on("error", (error) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      event: "db_idle_client_error",
      message: error.message,
      code: (error as { code?: string }).code,
    }),
  );
});

export const db = drizzle(pool, { schema });

/** Close the process-wide pool during graceful shutdown or integration teardown. */
export async function closeDb(): Promise<void> {
  await pool.end();
}

export { schema };
