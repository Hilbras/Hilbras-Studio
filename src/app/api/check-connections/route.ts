import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { socialAccounts } from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { checkConnectionHealth } from "@/lib/connection-health";

export async function GET(req: NextRequest) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ connected: [], permissionsMissing: [], expired: [] });
  }

  const rows = await db
    .select({ platform: socialAccounts.platform })
    .from(socialAccounts)
    .where(eq(socialAccounts.userId, session.id));

  const connected = [...new Set(rows.map((r) => r.platform))];

  // `connected` only says a token is stored. The health check says whether it
  // can do anything: `permissionsMissing` covers Meta's empty-grant answer
  // (code 100 / error_subcode 10) and `expired` covers sessions that ran out —
  // both look like a green "Connected" badge otherwise, and both only surface
  // as a failed publish. See `checkConnectionHealth` for why each state exists.
  const health = await checkConnectionHealth(session.id);

  return NextResponse.json({
    connected,
    permissionsMissing: health.permissionsMissing,
    expired: health.expired,
  });
}
