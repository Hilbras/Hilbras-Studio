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
