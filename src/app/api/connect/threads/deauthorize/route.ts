import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { socialAccounts } from "@/db/schema";
import { readThreadsAppSecrets, verifyThreadsSignedRequest } from "@/lib/signed-request";

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

  const candidates = await readThreadsAppSecrets();
  if (candidates.length === 0) {
    return NextResponse.json(
      { error: "app secret not configured" },
      { status: 500 }
    );
  }

  const verified = verifyThreadsSignedRequest(signedRequest, candidates);
  const threadsUserId =
    verified && typeof verified.payload.user_id === "string"
      ? verified.payload.user_id
      : null;

  if (!verified || !threadsUserId) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const conditions = [
    eq(socialAccounts.platform, "threads"),
    eq(socialAccounts.platformAccountId, threadsUserId),
  ];
  // A tenant's own saved secret may only ever touch that tenant's rows; the
  // deployment-level env secret (owner null) is trusted across the deploy.
  if (verified.ownerUserId !== null) {
    conditions.push(eq(socialAccounts.userId, verified.ownerUserId));
  }
  await db.delete(socialAccounts).where(and(...conditions));

  return new NextResponse(null, { status: 200 });
}
