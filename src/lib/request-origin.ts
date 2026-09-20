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
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/+$/, "");
  }

  // Local dev / tunnels: derive from headers
  const url = new URL(req.url);

  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    url.protocol.replace(":", "");

  const host =
    req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    req.headers.get("host") ||
    url.host;

  return `${proto}://${host}`;
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
