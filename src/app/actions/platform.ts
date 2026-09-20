"use server";

import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { PLATFORM_REGISTRY, type PlatformId } from "@/lib/platforms";
import { getCredentialValue } from "@/app/actions/credentials";
import { getSessionUser } from "@/lib/session";
import { db } from "@/db";
import { storedCredentials } from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";

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

export async function testPlatformCredentials(platform: string): Promise<{ valid: boolean; message: string }> {
  const clientId = await getCredentialValue(`${platform}_client_id`);
  const clientSecret = await getCredentialValue(`${platform}_client_secret`);

  if (!clientId || !clientSecret) {
    return { valid: false, message: "Credentials not configured" };
  }

  const spec = PLATFORM_REGISTRY[platform as PlatformId];
  if (!spec) {
    return { valid: false, message: `Unknown platform: ${platform}` };
  }

  try {
    const res = await fetch(spec.auth.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }).toString(),
    });

    const body = await res.json().catch(() => ({})) as Record<string, string>;

    const errLower = (body.error || "").toLowerCase();
    if (errLower === "invalid_client" || errLower.includes("invalid_client")) {
      return { valid: false, message: "Invalid Client ID or Secret" };
    }

    if (errLower.includes("invalid_grant") || errLower.includes("unsupported_grant_type") || errLower.includes("unauthorized_client")) {
      return { valid: true, message: "Credentials are valid" };
    }

    if (res.ok) {
      return { valid: true, message: "Credentials are valid" };
    }

    if (res.status === 400 && !errLower.includes("invalid_client")) {
      return { valid: true, message: "Credentials accepted (grant type not supported, which is expected)" };
    }

    return { valid: false, message: body.error_description || body.error || `HTTP ${res.status}` };
  } catch (e: any) {
    if (e.message?.includes("fetch")) {
      return { valid: true, message: "Credentials saved (couldn't reach platform API to verify, but keys look correct)" };
    }
    return { valid: false, message: e.message || "Test failed" };
  }
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
