/**
 * Structured event logging (remediation Task 18).
 *
 * One JSON object per line on stdout, so a serverless platform (Vercel) or any
 * log shipper can filter on `event` without regexing prose. Events carry a
 * stable snake_case name and flat fields — never a nested bag — so the query
 * surface is predictable:
 *
 *   {"ts":"2026-09-29T21:00:00.000Z","level":"warn","event":"token_refresh_failed","platform":"x","status":401}
 *
 * What must flow through here (plan Task 18): publish outcomes, token
 * failures, AI budget denials, scheduler lease activity, and account
 * lifecycle. Never log a secret, a token, or a full URL with one embedded —
 * the existing URL conventions in this codebase (token in the query string)
 * make "just log the URL" a credential leak.
 */

export type LogLevel = "info" | "warn" | "error";

function emit(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export const log = {
  /** Routine, expected outcomes: a publish finished, a token renewed. */
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  /** Something failed but is retried or recoverable: a refresh attempt, a denial. */
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  /** The caller could not do its job at all. */
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
