/**
 * Error classification for the legacy publishing path.
 *
 * The existing publishers in `@/lib/publish` return a human-readable `error`
 * string rather than a typed error, so this module is the bridge: it maps those
 * strings onto `ConnectorErrorCode` **once, here**, so the Runtime never has to
 * match on message text.
 *
 * This is deliberately a temporary seam. Phase 3 replaces it when each connector
 * reports its platform's own error taxonomy (HTTP status, Graph `code`,
 * Telegram `error_code`) directly, at which point `classifyLegacyError` and its
 * string table are deleted rather than extended. New connectors must not grow
 * this table — they construct `ConnectorError` themselves.
 */

import type { ConnectorError, ConnectorErrorCode } from "./types";

/**
 * Retry policy per code.
 *
 * The only codes marked retryable are ones where the *same request* can succeed
 * later. `unknown` is deliberately not retryable: an unclassified failure on a
 * side-effecting step is the "uncertain outcome" case the scheduler already
 * handles by refusing to retry blindly.
 */
const RETRYABLE: ReadonlySet<ConnectorErrorCode> = new Set<ConnectorErrorCode>([
  "rate_limited",
  "platform_error",
]);

function error(
  code: ConnectorErrorCode,
  message: string,
): ConnectorError {
  return { code, message, retryable: RETRYABLE.has(code) };
}

/**
 * Classify one of the legacy publishers' error strings.
 *
 * Order matters: the expired-session message also contains the platform name
 * and the word "expired", so it is tested before the generic patterns.
 */
export function classifyLegacyError(
  platform: string,
  raw: string,
): ConnectorError {
  const message = raw.trim();
  const lower = message.toLowerCase();

  // `tokenExpiredMessage()` — "X: the session expired and must be renewed …"
  if (lower.includes("session expired") || lower.includes("must be renewed")) {
    return error("expired", message);
  }

  // `connectionError(..., "expired")` reaches some paths as a bare phrase.
  if (lower.includes("expired")) {
    return error("expired", message);
  }

  // `connectionError(..., "not_connected")` — "X not connected".
  if (lower.includes("not connected") || lower.includes("not_connected")) {
    return error("not_connected", message);
  }

  // The `default` arm of `publishForUser` for a connect-only platform.
  if (
    lower.includes("not yet supported") ||
    lower.includes("publishing is not implemented")
  ) {
    return error("unsupported", message);
  }

  // The target account is unreachable even though the connection is fine.
  // Checked before the permission patterns because Telegram phrases a missing
  // chat as a rights problem, and conflating the two would point the user at
  // the wrong fix.
  if (lower.includes("chat not found") || lower.includes("wrong chat id")) {
    return error("target_unavailable", message);
  }

  // Permission problems. Checked before the rate-limit and content patterns
  // because several platforms describe throttling as a permission failure.
  if (
    lower.includes("enough rights") ||
    lower.includes("no rights") ||
    lower.includes("permission") ||
    lower.includes("forbidden") ||
    lower.includes("unauthorized") ||
    lower.includes("not authorized") ||
    lower.includes("can't send") ||
    lower.includes("cannot send")
  ) {
    return error("forbidden", message);
  }

  if (
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("slow down") ||
    lower.includes("try again later")
  ) {
    return error("rate_limited", message);
  }

  // Content rejections: the platform understood the request and said no.
  if (
    lower.includes("too long") ||
    lower.includes("exceeds") ||
    lower.includes("invalid") ||
    lower.includes("unsupported media") ||
    lower.includes("must be") ||
    lower.includes("is required")
  ) {
    return error("invalid_content", message);
  }

  return error("unknown", message);
}

/** A failure with no message at all — a thrown value, or a rejected promise. */
export function unknownError(platform: string, cause: unknown): ConnectorError {
  const message =
    cause instanceof Error && cause.message
      ? cause.message
      : `${platform} publish failed`;
  return error("unknown", message);
}
