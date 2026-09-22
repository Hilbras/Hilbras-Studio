import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

/**
 * Instagram webhook endpoint (App Dashboard → Instagram → Configure webhooks).
 *
 * Meta verifies the endpoint with a GET handshake: it sends `hub.mode`,
 * `hub.verify_token` and `hub.challenge`, and requires the challenge echoed
 * back as plain text with a 200. The token must match
 * `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`, set to the same string entered in the
 * App Dashboard's Verify token field.
 *
 * Event deliveries (POST) are HMAC-checked with `X-Hub-Signature-256` over
 * the raw body, keyed by the subscribed app's secret
 * (`INSTAGRAM_CLIENT_SECRET`). Everything fails closed: no secret configured
 * means no accepted delivery.
 *
 * Publishing does not depend on webhooks — they exist for real-time events
 * (new DMs, comments, mentions) that the inbox currently picks up by polling.
 */

/** Constant-time compare that also tolerates differing lengths. */
function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");
  const expected = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN;

  if ((mode !== "subscribe" && mode !== "unsubscribe") || !challenge) {
    return new NextResponse("Invalid handshake", { status: 400 });
  }
  // Fails closed when the env var is missing (expected === undefined).
  if (!token || !expected || !timingSafeEqualString(token, expected)) {
    return new NextResponse("Verify token mismatch", { status: 403 });
  }
  // Meta requires the challenge echoed back verbatim as plain text.
  return new NextResponse(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

/**
 * Event notifications. Meta retries any delivery that does not answer 200
 * quickly, so acknowledged deliveries are well-formed only after the
 * signature check; processing (wiring events into the inbox) comes later.
 */
export async function POST(req: NextRequest) {
  const body = await req.text().catch(() => "");
  const secret = process.env.INSTAGRAM_CLIENT_SECRET;

  if (!secret) {
    return new NextResponse("Webhook secret not configured", { status: 403 });
  }

  const signature = req.headers.get("x-hub-signature-256");
  if (!signature?.startsWith("sha256=")) {
    return new NextResponse("Missing signature", { status: 403 });
  }

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(body).digest("hex");
  if (!timingSafeEqualString(signature, expected)) {
    return new NextResponse("Invalid signature", { status: 403 });
  }

  return NextResponse.json({ received: true });
}
