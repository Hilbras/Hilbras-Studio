import crypto from "node:crypto";
import { desc, eq } from "drizzle-orm";

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

/** A candidate secret and, for UI-saved secrets, the tenant that owns it. */
export interface ThreadsSecretCandidate {
  secret: string;
  /**
   * The user who saved this secret via the UI, or null for the
   * deployment-level `THREADS_CLIENT_SECRET`. Destructive callbacks verified
   * with a tenant's secret must stay scoped to that tenant's rows.
   */
  ownerUserId: string | null;
}

export interface VerifiedThreadsRequest {
  payload: Record<string, unknown>;
  ownerUserId: string | null;
}

/**
 * Every Threads app secret a callback could legitimately have been signed with,
 * most recently saved first.
 *
 * These webhooks are called by Meta's servers, so there is no session and the
 * secret cannot be looked up per user — it has to be every candidate we know
 * about. A secret can live in two places:
 *
 *   1. the Settings UI, which stores one encrypted row per user
 *   2. `THREADS_CLIENT_SECRET`, the setup described in docs/THREADS_SETUP.md
 *
 * Both are collected, and the signature is checked against each in turn. That
 * also means a secret rotated in the UI keeps verifying callbacks signed with
 * the previous secret until Meta switches over. Each candidate carries its
 * owner so callers can scope deletes — a tenant's secret must never act on
 * another tenant's connection.
 */
export async function readThreadsAppSecrets(): Promise<ThreadsSecretCandidate[]> {
  const rows = await db
    .select({
      encryptedValue: storedCredentials.encryptedValue,
      userId: storedCredentials.userId,
    })
    .from(storedCredentials)
    .where(eq(storedCredentials.keyName, "threads_client_secret"))
    .orderBy(desc(storedCredentials.updatedAt));

  const candidates: ThreadsSecretCandidate[] = [];
  const add = (secret: string | null | undefined, ownerUserId: string | null) => {
    const trimmed = secret?.trim();
    if (!trimmed) return;
    if (candidates.some((c) => c.secret === trimmed)) return;
    candidates.push({ secret: trimmed, ownerUserId });
  };

  for (const row of rows) {
    if (!row.encryptedValue) continue;
    try {
      add(decryptSecret(row.encryptedValue), row.userId ?? null);
    } catch {
      // Row can't be decrypted (e.g. the encryption key changed) — skip it
      // rather than failing every candidate.
    }
  }

  add(process.env.THREADS_CLIENT_SECRET, null);
  return candidates;
}

/**
 * Verify a Meta `signed_request` against any of the candidate secrets and
 * return its payload plus the owning tenant, or null when none match.
 */
export function verifyThreadsSignedRequest(
  signedRequest: string,
  candidates: ThreadsSecretCandidate[]
): VerifiedThreadsRequest | null {
  for (const candidate of candidates) {
    const payload = parseSignedRequest(signedRequest, candidate.secret);
    if (payload) {
      return { payload, ownerUserId: candidate.ownerUserId };
    }
  }
  return null;
}
