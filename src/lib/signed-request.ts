import crypto from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { storedCredentials } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";

/**
 * Meta (Facebook/Threads/Instagram) sends sensitive callbacks — deauthorization
 * and data-deletion requests — as a `signed_request` form field:
 *
 *   signed_request = base64url(HMAC_SHA256(payload, appSecret)) + "." + base64url(payload)
 *
 * Verifying the HMAC proves the request genuinely came from Meta.
 */
export function parseSignedRequest(
  signedRequest: string,
  appSecret: string
): Record<string, unknown> | null {
  const dot = signedRequest.indexOf(".");
  if (dot === -1) return null;

  const sigB64 = signedRequest.slice(0, dot);
  const payloadB64 = signedRequest.slice(dot + 1);

  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(payloadB64)
    .digest("base64url");

  const sigBuf = Buffer.from(sigB64, "base64url");
  const expBuf = Buffer.from(expected, "base64url");
  if (
    sigBuf.length !== expBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expBuf)
  ) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Read the Threads app secret directly from the DB without a session check —
 * Meta's servers call these callbacks, so no user cookie will be present.
 */
export async function readThreadsAppSecret(): Promise<string | null> {
  const [row] = await db
    .select({ encryptedValue: storedCredentials.encryptedValue })
    .from(storedCredentials)
    .where(eq(storedCredentials.keyName, "threads_client_secret"))
    .limit(1);

  if (!row?.encryptedValue) return null;
  try {
    return decryptSecret(row.encryptedValue);
  } catch {
    return null;
  }
}
