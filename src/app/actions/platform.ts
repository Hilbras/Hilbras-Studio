"use server";

import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { PLATFORM_REGISTRY, type PlatformId } from "@/lib/platforms";
import { getCredentialValue } from "@/app/actions/credentials";
import { getSessionUser } from "@/lib/session";
import { db } from "@/db";
import { socialAccounts, storedCredentials } from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";
import { verifyAppCredentials } from "@/lib/platform-app-check";
import { originFromHeaders } from "@/lib/request-origin";

/** A platform slug — it becomes part of stored credential key names, so it is bounded before interpolation. */
const platformParam = z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/, "Invalid platform");

const platformCredentialsSchema = z.object({
  platform: platformParam,
  clientId: z.string().trim().min(1, "Client ID is required").max(500),
  clientSecret: z.string().trim().min(1, "Client secret is required").max(500),
});

export async function getPlatformCredentials(platform: string): Promise<{ clientId: string | null; clientSecret: string | null }> {
  const parsed = platformParam.safeParse(platform);
  if (!parsed.success) return { clientId: null, clientSecret: null };
  const clientId = await getCredentialValue(`${parsed.data}_client_id`);
  const clientSecret = await getCredentialValue(`${parsed.data}_client_secret`);
  return { clientId, clientSecret };
}

export async function checkCredentialsExist(platform: string): Promise<boolean> {
  const parsed = platformParam.safeParse(platform);
  if (!parsed.success) return false;
  const clientId = await getCredentialValue(`${parsed.data}_client_id`);
  const clientSecret = await getCredentialValue(`${parsed.data}_client_secret`);
  return !!(clientId && clientSecret);
}

/**
 * Ask the platform itself whether the saved app credentials are its own.
 *
 * This deliberately does *not* guess from `grant_type=client_credentials`: Meta
 * answers that with a 400 for credentials it otherwise accepts, which is how a
 * wrong app pair used to be reported as "Credentials accepted" — the exact
 * reassurance that sends users to a dead end at the provider's authorize page.
 * See `verifyAppCredentials` for the check itself.
 */
export async function testPlatformCredentials(platform: string): Promise<{ valid: boolean; message: string }> {
  const spec = PLATFORM_REGISTRY[platform as PlatformId];
  if (!spec) {
    return { valid: false, message: `Unknown platform: ${platform}` };
  }

  const clientId = await getCredentialValue(`${platform}_client_id`);
  const clientSecret = await getCredentialValue(`${platform}_client_secret`);

  if (!clientId || !clientSecret) {
    return { valid: false, message: "Credentials not configured" };
  }

  const verdict = await verifyAppCredentials(spec.id, { clientId, clientSecret });

  if (verdict.status === "invalid") {
    return { valid: false, message: verdict.message };
  }

  if (verdict.status === "valid") {
    return { valid: true, message: verdict.message };
  }

  // Unverified stays "saved" rather than "bad": a provider we could not reach
  // says nothing about the keys, and a red badge here would be a lie.
  return {
    valid: true,
    message: "Keys saved — could not be verified against the platform right now.",
  };
}

async function upsertCredential(userId: string, keyName: string, value: string, label: string) {
  const encrypted = encryptSecret(value);
  await db
    .insert(storedCredentials)
    .values({
      id: randomUUID(),
      userId,
      keyName,
      encryptedValue: encrypted,
      label,
    })
    .onConflictDoUpdate({
      target: [storedCredentials.userId, storedCredentials.keyName],
      set: { encryptedValue: encrypted, label, updatedAt: new Date() },
    });
}

export async function savePlatformCredentials(
  platform: string,
  clientId: string,
  clientSecret: string
): Promise<{ success: boolean; error?: string }> {
  const session = await getSessionUser();
  if (!session) return { success: false, error: "Not signed in" };

  const parsed = platformCredentialsSchema.safeParse({ platform, clientId, clientSecret });
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  if (!PLATFORM_REGISTRY[parsed.data.platform as PlatformId]) {
    return { success: false, error: `Unknown platform: ${parsed.data.platform}` };
  }

  try {
    const { platform: id, clientId: cid, clientSecret: secret } = parsed.data;
    await upsertCredential(session.id, `${id}_client_id`, cid, `${id} Client ID`);
    await upsertCredential(session.id, `${id}_client_secret`, secret, `${id} Client Secret`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Failed to save" };
  }
}

/**
 * Drop this user's stored connection for a platform.
 *
 * Exists because an OAuth grant belongs to the token it was issued for. When
 * Threads permissions change (the tester invitation is accepted, or App Review
 * approves `threads_basic`), the stored token keeps its old, empty grant forever,
 * and the connection would keep answering "connected" from `/api/check-connections`
 * while every publish fails. `api/connect/[platform]/callback` replaces the row on
 * a successful connect, so the way out is a fresh authorization — this is what
 * removes a dead one first, and what lets a user start over when the provider
 * keeps handing back the same unusable token.
 *
 * Only the *user's own* row for the platform is touched. Credentials
 * (`savePlatformCredentials`) are deliberately left alone: re-authorizing needs
 * them.
 */
export async function disconnectPlatform(platform: string): Promise<{ success: boolean; error?: string }> {
  const session = await getSessionUser();
  if (!session) return { success: false, error: "Not signed in" };

  const spec = PLATFORM_REGISTRY[platform as PlatformId];
  if (!spec) return { success: false, error: `Unknown platform: ${platform}` };

  try {
    await db
      .delete(socialAccounts)
      .where(
        and(
          eq(socialAccounts.userId, session.id),
          eq(socialAccounts.platform, spec.id)
        )
      );
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Failed to disconnect" };
  }
}

/**
 * The exact redirect URI this deployment sends to `platform`'s authorize page.
 *
 * Users have to register this string in the provider's dashboard (Meta: Use
 * cases → <use case> → Settings → **Client OAuth Settings → valid OAuth redirect
 * URIs**). Providers compare it literally — Meta rejects any difference,
 * including a trailing slash the dashboard added itself, with error 1349168
 * "URL Blocked". Showing the value the request will actually carry removes the
 * guesswork; resolving it from the same `requestOrigin` logic means the displayed
 * URL cannot drift from the one used by `api/connect/[platform]/authorize`.
 */
export async function getConnectRedirectUri(platform: string): Promise<string | null> {
  const spec = PLATFORM_REGISTRY[platform as PlatformId];
  if (!spec) return null;

  const origin = originFromHeaders(await headers());
  return origin ? `${origin}/api/connect/${spec.id}/callback` : null;
}
