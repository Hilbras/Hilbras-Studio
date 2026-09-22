import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { storedCredentials } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { PLATFORM_REGISTRY, type PlatformId } from "@/lib/platforms";

export interface PlatformAppCredentials {
  clientId: string;
  clientSecret: string;
}

/** Key names the Settings → Accounts form writes: `<platform>_client_id`. */
export function platformCredentialKeys(platform: string): {
  clientId: string;
  clientSecret: string;
} {
  return {
    clientId: `${platform}_client_id`,
    clientSecret: `${platform}_client_secret`,
  };
}

async function decryptUserCredential(
  userId: string,
  keyName: string
): Promise<string | null> {
  const [row] = await db
    .select({ encryptedValue: storedCredentials.encryptedValue })
    .from(storedCredentials)
    .where(
      and(
        eq(storedCredentials.userId, userId),
        eq(storedCredentials.keyName, keyName)
      )
    )
    .limit(1);

  if (!row?.encryptedValue) return null;
  try {
    return decryptSecret(row.encryptedValue);
  } catch {
    return null;
  }
}

/**
 * Resolve a platform's developer-app credentials for one user.
 *
 * Lookup order:
 *   1. that user's own row in `stored_credentials` (Settings → Accounts)
 *   2. the platform's env vars declared in `PLATFORM_REGISTRY.auth` (self-hosted
 *      setups that configure apps in `.env.local` instead of the UI)
 *
 * Rows belonging to other users are never used: each account on the deployment
 * connects through its own developer app, and a connect attempt must not be
 * able to borrow someone else's app secret.
 */
export async function readPlatformAppCredentials(
  userId: string,
  platform: PlatformId
): Promise<PlatformAppCredentials | null> {
  const keys = platformCredentialKeys(platform);
  const auth = PLATFORM_REGISTRY[platform].auth;
  // Manual platforms (Telegram) carry no app pair — their credential *is* the
  // per-user bot token, which never flows through this resolver.
  if (!auth) return null;

  const clientId =
    (await decryptUserCredential(userId, keys.clientId)) ??
    process.env[auth.clientIdEnv] ??
    null;

  const clientSecret =
    (await decryptUserCredential(userId, keys.clientSecret)) ??
    process.env[auth.clientSecretEnv] ??
    null;

  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}
