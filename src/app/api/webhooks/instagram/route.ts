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
 * Publishing does not depend on webhooks — they exist for real-time events
 * (new DMs, comments, mentions) that the inbox currently picks up by polling.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if ((mode !== "subscribe" && mode !== "unsubscribe") || !challenge) {
    return new NextResponse("Invalid handshake", { status: 400 });
  }
  if (!token || token !== process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN) {
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
 * quickly, so the body is acknowledged unconditionally — a malformed payload
 * must not trigger endless retries. Processing (wiring events into the inbox)
 * comes later.
 */
export async function POST(req: NextRequest) {
  await req.json().catch(() => null);
  return NextResponse.json({ received: true });
}
