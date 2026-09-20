import type { NextRequest } from "next/server";

/**
 * Return the public base URL of the application.
 *
 * Priority:
 *   1. APP_URL env var (set in production — guaranteed correct, no header tricks)
 *   2. Dynamic derivation from request headers (local dev / tunnels)
 *
 * Meta requires the OAuth redirect_uri to match the registered URL exactly,
 * so using a hardcoded env var in production eliminates any protocol / host
 * mismatch caused by reverse-proxy headers.
 */
export function requestOrigin(req: NextRequest): string {
  // Production: use the hardcoded env var — always correct
  return originFromHeaders(req.headers) || new URL(req.url).origin;
}

/**
 * Same resolution as `requestOrigin`, for server components and server actions
 * where only `headers()` is available (there is no `NextRequest`).
 *
 * Needed because the redirect URI shown to the user — the string they have to
 * register with the provider — must be the one the request itself will carry.
 * A mismatch, down to a trailing slash, comes back as error 1349168 "URL Blocked".
 */
export function originFromHeaders(headers: Headers): string {
  // Production: use the hardcoded env var — always correct
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/+$/, "");
  }

  // Local dev / tunnels: derive from headers
  const proto =
    headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";

  const host =
    headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    headers.get("host") ||
    "";

  return host ? `${proto}://${host}` : "";
}

/**
 * Normalise a redirect target that came from an untrusted source (the Referer
 * header or the OAuth `state` payload) into a safe same-origin path.
 *
 * Only the path and query survive — an absolute or protocol-relative URL from
 * another origin collapses to its path instead of turning the OAuth callback
 * into an open redirect. Anything unparseable falls back to the default.
 */
export function safeReturnPath(
  raw: string | null | undefined,
  fallback = "/accounts"
): string {
  if (!raw) return fallback;

  try {
    // Resolving against a placeholder base keeps relative paths intact while
    // forcing absolute URLs to expose (and then drop) their origin.
    const parsed = new URL(raw, "http://internal.invalid");
    const path = `${parsed.pathname}${parsed.search}`;
    return path.startsWith("/") ? path : fallback;
  } catch {
    return fallback;
  }
}
