import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { socialAccounts } from "@/db/schema";
import { readThreadsAppSecrets, verifyThreadsSignedRequest } from "@/lib/signed-request";

/**
 * Delete Callback (Meta data-deletion request).
 *
 * Meta POSTs `signed_request` here when a user requests their data be deleted
 * (GDPR/CCPA). We delete the stored Threads connection and respond with the
 * JSON Meta requires: { url, confirmation_code }.
 *
 * GET on this same URL serves a simple status page for the confirmation link.
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

  const secrets = await readThreadsAppSecrets();
  if (secrets.length === 0) {
    return NextResponse.json(
      { error: "app secret not configured" },
      { status: 500 }
    );
  }

  const payload = verifyThreadsSignedRequest(signedRequest, secrets);
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

  const confirmationCode = crypto.randomBytes(12).toString("hex");
  const origin = new URL(req.url).origin;

  return NextResponse.json({
    url: `${origin}/api/connect/threads/delete?confirmation_code=${confirmationCode}`,
    confirmation_code: confirmationCode,
  });
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("confirmation_code") ?? "unknown";
  // Hex-only expected; strip anything else before embedding in HTML.
  const code = raw.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64) || "unknown";

  const html = `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><title>Data Deletion Request</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; text-align: center;">
    <h1>Data deletion request received</h1>
    <p>Your Threads connection data has been deleted from Hilbras Studio.</p>
    <p>Confirmation code: <strong>${code}</strong></p>
  </body>
</html>`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
