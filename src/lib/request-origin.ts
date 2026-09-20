import type { NextRequest } from "next/server";

/**
 * Derive the public origin of a request, honoring reverse-proxy headers.
 *
 * Tunnels (ngrok / Cloudflare) terminate TLS and forward plain HTTP to the
 * Next.js server, so `req.url` alone yields `http://localhost:3000`. Meta
 * requires the OAuth redirect_uri to match the saved HTTPS URL exactly, so
 * we prefer x-forwarded-proto / x-forwarded-host when present.
 */
export function requestOrigin(req: NextRequest): string {
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
