import { sql } from "drizzle-orm";

import { db } from "@/db";

export interface RateLimitOutcome {
  allowed: boolean;
  /** Seconds until the window resets — served as `Retry-After` when blocked. */
  retryAfterSec: number;
  /** Calls left in the current window (0 when blocked). */
  remaining: number;
}

/**
 * Fixed-window counter backed by Postgres, so concurrent serverless
 * instances share one truth. Consumption is a single atomic upsert — two
 * racing requests can never both read "one call left" — and windows roll
 * over lazily on first touch after `reset_at` passes.
 */
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitOutcome> {
  const result = await db.execute(sql`
    INSERT INTO rate_limits (key, count, reset_at)
    VALUES (${key}, 1, now() + interval '1 second' * ${windowSeconds}::double precision)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.reset_at <= now()
        THEN 1 ELSE rate_limits.count + 1 END,
      reset_at = CASE WHEN rate_limits.reset_at <= now()
        THEN now() + interval '1 second' * ${windowSeconds}::double precision
        ELSE rate_limits.reset_at END
    RETURNING count, reset_at,
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM (reset_at - now()))))::int AS retry_after
  `);

  // Expired rows are dead weight — drop them opportunistically (~1 in 50
  // calls) instead of requiring a scheduled cleanup job.
  if (Math.random() < 0.02) {
    await db.execute(sql`DELETE FROM rate_limits WHERE reset_at <= now()`);
  }

  const rows = (
    result as unknown as {
      rows: Array<{ count: number; reset_at: Date; retry_after: number }>;
    }
  ).rows;
  const row = rows[0];
  if (!row) return { allowed: true, retryAfterSec: 0, remaining: limit };

  const allowed = row.count <= limit;
  return {
    allowed,
    // The seconds come from the DB clock: reset_at is a naive timestamp, so
    // a JS-side delta would misread it through the driver's timezone rules.
    retryAfterSec: Math.max(1, Number(row.retry_after) || 1),
    remaining: allowed ? Math.max(0, limit - row.count) : 0,
  };
}
