"use server";

import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { eq, and } from "drizzle-orm";
import { PLATFORM_REGISTRY, type PlatformId } from "@/lib/platforms";
import { getCredentialValue } from "@/app/actions/credentials";
import { getSessionUser } from "@/lib/session";
import { db } from "@/db";
import { storedCredentials } from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";
import { verifyAppCredentials } from "@/lib/platform-app-check";
import { originFromHeaders } from "@/lib/request-origin";

export async function getPlatformCredentials(platform: string): Promise<{ clientId: string | null; clientSecret: string | null }> {
  const clientId = await getCredentialValue(`${platform}_client_id`);
  const clientSecret = await getCredentialValue(`${platform}_client_secret`);
  return { clientId, clientSecret };
}

export async function checkCredentialsExist(platform: string): Promise<boolean> {
  const clientId = await getCredentialValue(`${platform}_client_id`);
  const clientSecret = await getCredentialValue(`${platform}_client_secret`);
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

  try {
    await upsertCredential(session.id, `${platform}_client_id`, clientId, `${platform} Client ID`);
    await upsertCredential(session.id, `${platform}_client_secret`, clientSecret, `${platform} Client Secret`);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || "Failed to save" };
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
