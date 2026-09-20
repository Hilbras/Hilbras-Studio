import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { getSessionUser } from "@/lib/session";
import { db, schema } from "@/db";
import { socialAccounts, storedCredentials } from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";
import { PLATFORM_REGISTRY, type PlatformId } from "@/lib/platforms";
import { requestOrigin } from "@/lib/request-origin";

/** Read credential directly from DB without session check (for OAuth callback). */
async function readCredentialDirect(keyName: string): Promise<string | null> {
  const [row] = await db
    .select({ encryptedValue: storedCredentials.encryptedValue })
    .from(storedCredentials)
    .where(eq(storedCredentials.keyName, keyName))
    .limit(1);
  if (!row?.encryptedValue) return null;
  try {
    // Dynamic import to avoid circular
    const { decryptSecret } = await import("@/lib/crypto");
    return decryptSecret(row.encryptedValue);
  } catch {
    return null;
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  const { platform: platformIdStr } = await params;
  const platform = PLATFORM_REGISTRY[platformIdStr as PlatformId];
  if (!platform) return NextResponse.redirect(new URL("/accounts?error=unknown_platform", req.url));

  // Read from DB directly (no session check needed for OAuth callback)
  const clientId = await readCredentialDirect(`${platformIdStr}_client_id`);
  const clientSecret = await readCredentialDirect(`${platformIdStr}_client_secret`);

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(new URL("/accounts?error=credentials_missing", req.url));
  }

  const session = await getSessionUser();
  if (!session) return NextResponse.redirect(new URL("/login", req.url));

  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const stateStr = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    return NextResponse.redirect(new URL(`/accounts?error=${encodeURIComponent(error)}`, req.url));
  }
  if (!code || !stateStr) {
    return NextResponse.redirect(new URL("/accounts?error=missing_code_or_state", req.url));
  }

  let state: { userId: string; returnUrl: string };
  try {
    state = JSON.parse(Buffer.from(stateStr, "base64url").toString());
  } catch {
    return NextResponse.redirect(new URL("/accounts?error=invalid_state", req.url));
  }
  if (state.userId !== session.id) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const verifierCookieName = `pkce_${platformIdStr}`;
  const codeVerifier = req.cookies.get(verifierCookieName)?.value ?? "";
  if (!codeVerifier) {
    return NextResponse.redirect(new URL("/accounts?error=missing_pkce_verifier", req.url));
  }
  req.cookies.delete(verifierCookieName);

  // Token exchange
  const tokenHeaders: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (platform.auth.extraHeaders) Object.assign(tokenHeaders, platform.auth.extraHeaders);

  const tokenRes = await fetch(platform.auth.tokenUrl, {
    method: "POST",
    headers: tokenHeaders,
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${requestOrigin(req)}/api/connect/${platformIdStr}/callback`,
      code_verifier: codeVerifier,
    }).toString(),
  });

  if (!tokenRes.ok) {
    return NextResponse.redirect(new URL(`/accounts?error=${encodeURIComponent(`token_exchange_failed:${tokenRes.status}`)}`, req.url));
  }

  const tokenData = await tokenRes.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    user_id?: string;
    username?: string;
  };

  if (!tokenData.access_token) {
    return NextResponse.redirect(new URL("/accounts?error=no_access_token", req.url));
  }

  // Fetch profile
  let profileUsername: string | undefined;
  let platformAccountId: string | undefined;

  if (platformIdStr === "instagram") {
    const profileRes = await fetch(`https://graph.instagram.com/me?fields=username,account_type&access_token=${encodeURIComponent(tokenData.access_token)}`);
    if (profileRes.ok) {
      const profile = await profileRes.json() as { username?: string; id?: string; account_type?: string };
      profileUsername = profile.username;
      platformAccountId = profile.id;
      if (profile.account_type === "NONE") {
        return NextResponse.redirect(new URL("/accounts?error=instagram_personal_only", req.url));
      }
    }
  } else if (platformIdStr === "threads") {
    const profileRes = await fetch(`https://graph.threads.net/me?fields=username&access_token=${encodeURIComponent(tokenData.access_token)}`);
    if (profileRes.ok) {
      const profile = await profileRes.json() as { username?: string; id?: string };
      profileUsername = profile.username;
      platformAccountId = profile.id;
    }
  }

  const expiresAt = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null;

  await db.insert(schema.socialAccounts).values({
    id: randomUUID(),
    userId: session.id,
    platform: platformIdStr,
    platformAccountId: (platformAccountId ?? tokenData.user_id ?? "unknown")!,
    username: profileUsername ?? tokenData.username ?? null,
    accessTokenEnc: encryptSecret(tokenData.access_token),
    refreshTokenEnc: tokenData.refresh_token ? encryptSecret(tokenData.refresh_token) : null,
    tokenExpiresAt: expiresAt,
  });

  const redirectUrl = state.returnUrl.includes("?")
    ? `${state.returnUrl}&connected=${encodeURIComponent(platformIdStr)}`
    : `${state.returnUrl}?connected=${encodeURIComponent(platformIdStr)}`;
  return NextResponse.redirect(new URL(redirectUrl, req.url));
}