import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { publishDuePosts } from "@/lib/scheduled-posts";
import { refreshExpiringTokens } from "@/lib/token-maintenance";
import { getSessionUser } from "@/lib/session";
import { isSameOriginRequest } from "@/lib/request-origin";

/**
 * Scheduled-post runner endpoint.
 *
 * `GET` is reserved for Vercel Cron and accepts only the server-side bearer
 * secret. A signed-in browser session is intentionally not accepted here: it
 * keeps a cacheable GET from becoming a state-changing publish trigger.
 *
 * The Scheduler's "Publish due now" button uses `POST`, which requires both a
 * valid session and a same-origin browser request. The route never accepts a
 * user id from the caller; it derives the scope from the authenticated session.
 */

/**
 * Execution budget for this endpoint. The runner's own deadline
 * (`DEFAULT_RUN_DEADLINE_MS`, 100s) stops claiming posts well before this, so
 * the function returns cleanly instead of being terminated mid-publish — a
 * hard termination is exactly what turns a live publish into an uncertain,
 * potentially duplicated one. Comfortably under Vercel's 300s Hobby maximum.
 */
export const maxDuration = 120;

/** Constant-time comparison, so the secret cannot be recovered byte by byte. */
function matchesCronSecret(header: string | null, secret: string): boolean {
  if (!header) return false;

  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const actual = Buffer.from(header, "utf8");

  return (
    expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
  );
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !matchesCronSecret(req.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Renew expiring sessions first, so the posts published just below run on a
  // fresh token — and so a platform with nothing due still gets its token
  // topped up instead of quietly expiring on day 60.
  const tokens = await refreshExpiringTokens();
  const summary = await publishDuePosts();
  return NextResponse.json({ scope: "all-users", tokens, ...summary });
}

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const tokens = await refreshExpiringTokens(session.id);
  const summary = await publishDuePosts({ userId: session.id });
  return NextResponse.json({ scope: "single-user", tokens, ...summary });
}
