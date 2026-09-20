import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { socialAccounts } from "@/db/schema";
import { parseSignedRequest, readThreadsAppSecret } from "@/lib/signed-request";

/**
 * Uninstall Callback (Meta deauthorization notification).
 *
 * Meta POSTs `signed_request` here when a user removes the app from their
 * Threads/Facebook account. We verify the signature, then drop the stored
 * connection so we never keep dead tokens.
 */
export async function POST(req: NextRequest) {
  let signedRequest: string | null = null;
  try {
    const body = await req.formData();
    const value = body.get("signed_request");
    if (typeof value === "string") signedRequest = value;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (!signedRequest) {
    return NextResponse.json({ error: "missing signed_request" }, { status: 400 });
  }

  const appSecret = await readThreadsAppSecret();
  if (!appSecret) {
    return NextResponse.json(
      { error: "app secret not configured" },
      { status: 500 }
    );
  }

  const payload = parseSignedRequest(signedRequest, appSecret);
  const userId =
    payload && typeof payload.user_id === "string" ? payload.user_id : null;

  if (!userId) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  await db
    .delete(socialAccounts)
    .where(
      and(
        eq(socialAccounts.platform, "threads"),
        eq(socialAccounts.platformAccountId, userId)
      )
    );

  return new NextResponse(null, { status: 200 });
}
