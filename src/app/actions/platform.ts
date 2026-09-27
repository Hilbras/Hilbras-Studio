"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { PLATFORM_REGISTRY, type PlatformId } from "@/lib/platforms";
import { savePlatformCredentialsForUser } from "@/lib/platform-credential-store";
import { getUserCredentialValue } from "@/lib/credential-store";
import { getSessionUser } from "@/lib/session";
import { disconnectPlatform as removeAllAccountsForPlatform } from "@/lib/accounts/store";
import { verifyAppCredentials } from "@/lib/platform-app-check";
import { originFromHeaders } from "@/lib/request-origin";
import { toPlatformCredentialStatus } from "@/lib/credential-status";

/** A platform slug — it becomes part of stored credential key names, so it is bounded before interpolation. */
const platformParam = z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/, "Invalid platform");

export async function getPlatformCredentialStatus(platform: string) {
  const parsed = platformParam.safeParse(platform);
  const session = await getSessionUser();
  if (!parsed.success || !session) return toPlatformCredentialStatus(null, null);
  const clientId = await getUserCredentialValue(
    session.id,
    `${parsed.data}_client_id`,
  );
  const clientSecret = await getUserCredentialValue(
    session.id,
    `${parsed.data}_client_secret`,
  );
  return toPlatformCredentialStatus(clientId, clientSecret);
}

export async function checkCredentialsExist(platform: string): Promise<boolean> {
  const parsed = platformParam.safeParse(platform);
  const session = await getSessionUser();
  if (!parsed.success || !session) return false;
  const clientId = await getUserCredentialValue(
    session.id,
    `${parsed.data}_client_id`,
  );
  const clientSecret = await getUserCredentialValue(
    session.id,
    `${parsed.data}_client_secret`,
  );
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

  const session = await getSessionUser();
  if (!session) return { valid: false, message: "Not signed in" };

  const clientId = await getUserCredentialValue(
    session.id,
    `${spec.id}_client_id`,
  );
  const clientSecret = await getUserCredentialValue(
    session.id,
    `${spec.id}_client_secret`,
  );

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

/** Save platform credentials for the current session. */
export async function savePlatformCredentials(
  platform: string,
  clientId: string,
  clientSecret: string,
): Promise<{ success: boolean; error?: string }> {
  const session = await getSessionUser();
  if (!session) return { success: false, error: "Not signed in" };
  return savePlatformCredentialsForUser(
    session.id,
    platform,
    clientId,
    clientSecret,
  );
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
    // Removes every account on the platform and the grants behind them
    // (ADR-006). This action is the coarse "remove this platform" control;
    // per-account removal is disconnectAccount() in the accounts store.
    await removeAllAccountsForPlatform(session.id, spec.id);
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
