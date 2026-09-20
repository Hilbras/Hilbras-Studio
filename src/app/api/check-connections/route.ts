import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { socialAccounts } from "@/db/schema";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ connected: [] });

  const rows = await db
    .select({ platform: socialAccounts.platform })
    .from(socialAccounts)
    .where(eq(socialAccounts.userId, session.id));

  const connected = [...new Set(rows.map((r) => r.platform))];
  return NextResponse.json({ connected });
}