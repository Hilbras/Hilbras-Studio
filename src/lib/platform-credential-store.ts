import "server-only";

import { z } from "zod";

import { getUserCredentialValue, upsertUserCredential } from "@/lib/credential-store";
import { PLATFORM_REGISTRY, type PlatformId } from "@/lib/platforms";

/**
 * A platform slug is used in stored key names, so keep it deliberately narrow
 * before interpolating it into a credential key.
 */
const platformParam = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,29}$/, "Invalid platform");

const platformCredentialsSchema = z.object({
  platform: platformParam,
  clientId: z.string().trim().min(1, "Client ID is required").max(500),
  // Blank is meaningful for an edit: preserve the existing write-only secret.
  clientSecret: z.string().trim().max(500),
});

export interface SavePlatformCredentialsResult {
  success: boolean;
  error?: string;
}

/**
 * Persist a platform app credential pair for an already-authorized user.
 *
 * This deliberately lives outside the `use server` action module. The user ID
 * is an authorization boundary here, not an argument a browser caller may
 * choose; browser-facing actions must obtain it from the server session and
 * call this helper only after that check.
 */
export async function savePlatformCredentialsForUser(
  userId: string,
  platform: string,
  clientId: string,
  clientSecret: string,
): Promise<SavePlatformCredentialsResult> {
  const parsed = platformCredentialsSchema.safeParse({
    platform,
    clientId,
    clientSecret,
  });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const id = parsed.data.platform as PlatformId;
  if (!PLATFORM_REGISTRY[id]) {
    return { success: false, error: `Unknown platform: ${id}` };
  }

  try {
    const { clientId: cid, clientSecret: secret } = parsed.data;
    if (!secret) {
      const existingSecret = await getUserCredentialValue(
        userId,
        `${id}_client_secret`,
      );
      if (!existingSecret) {
        return {
          success: false,
          error: "Client secret is required for a new credential set",
        };
      }
    }

    await upsertUserCredential(
      userId,
      `${id}_client_id`,
      cid,
      `${id} Client ID`,
    );
    if (secret) {
      await upsertUserCredential(
        userId,
        `${id}_client_secret`,
        secret,
        `${id} Client Secret`,
      );
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to save",
    };
  }
}
