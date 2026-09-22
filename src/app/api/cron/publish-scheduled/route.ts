import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { publishDuePosts } from "@/lib/scheduled-posts";
import { refreshExpiringTokens } from "@/lib/token-maintenance";
import { getSessionUser } from "@/lib/session";

/**
 * Scheduled-post runner endpoint. Two ways in, with deliberately different scope:
 *
 *   1. Vercel Cron — sends `Authorization: Bearer $CRON_SECRET` automatically
 *      when CRON_SECRET is set on the project. Runs every user's due queue.
 *   2. A signed-in user — no secret needed, but only their own queued posts are
 *      processed. This backs the Scheduler's "Publish due now" button, and is how
 *      a post goes out on time on Vercel's Hobby plan, where cron jobs may only
 *      run once a day.
 *
 * Anyone else gets a 401. A session caller can never trigger another user's
 * queue, so the endpoint is safe to leave publicly reachable.
 */

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

  if (secret && matchesCronSecret(req.headers.get("authorization"), secret)) {
    // Renew expiring sessions first, so the posts published just below run on
    // a fresh token — and so a platform with nothing due still gets its token
    // topped up instead of quietly expiring on day 60.
    const tokens = await refreshExpiringTokens();
    const summary = await publishDuePosts();
    return NextResponse.json({ scope: "all-users", tokens, ...summary });
  }

  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const tokens = await refreshExpiringTokens(session.id);
  const summary = await publishDuePosts({ userId: session.id });
  return NextResponse.json({ scope: "single-user", tokens, ...summary });
}