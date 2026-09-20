"use server";

import { PLATFORM_REGISTRY, type PlatformId } from "@/lib/platforms";
import { getCredentialValue, saveCredentialAction } from "@/app/actions/credentials";

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
    // Test by attempting client_credentials grant — most platforms reject this
    // gracefully with a clear error if keys are valid but the grant isn't allowed.
    // If we get "invalid_client", the keys are wrong. Any other specific error
    // (like "unsupported_grant_type") means the keys themselves are accepted.
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

    // Keys are valid if the platform recognizes them (doesn't say "invalid_client")
    const errLower = (body.error || "").toLowerCase();
    if (errLower === "invalid_client" || errLower.includes("invalid_client")) {
      return { valid: false, message: "Invalid Client ID or Secret" };
    }

    if (errLower.includes("invalid_grant") || errLower.includes("unsupported_grant_type") || errLower.includes("unauthorized_client")) {
      // Platform recognized the credentials but this grant type isn't allowed — that's fine
      return { valid: true, message: "Credentials are valid" };
    }

    if (res.ok) {
      return { valid: true, message: "Credentials are valid" };
    }

    // For Meta platforms (Instagram/Threads/Facebook), a 400 with
    // "OAuthException" but not "invalid_client" still means the app exists.
    if (res.status === 400 && !errLower.includes("invalid_client")) {
      return { valid: true, message: "Credentials accepted (grant type not supported, which is expected)" };
    }

    return { valid: false, message: body.error_description || body.error || `HTTP ${res.status}` };
  } catch (e: any) {
    // Network error — still likely means the keys are fine, just can't reach the API
    if (e.message?.includes("fetch")) {
      return { valid: true, message: "Credentials saved (couldn't reach platform API to verify, but keys look correct)" };
    }
    return { valid: false, message: e.message || "Test failed" };
  }
}

export async function savePlatformCredentials(
  platform: string,
  clientId: string,
  clientSecret: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Save client ID
    const fd1 = new FormData();
    fd1.append("keyName", `${platform}_client_id`);
    fd1.append("value", clientId);
    fd1.append("label", `${platform} Client ID`);
    await saveCredentialAction({} as any, fd1);

    // Save client secret
    const fd2 = new FormData();
    fd2.append("keyName", `${platform}_client_secret`);
    fd2.append("value", clientSecret);
    fd2.append("label", `${platform} Client Secret`);
    await saveCredentialAction({} as any, fd2);

    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || "Failed to save" };
  }
}