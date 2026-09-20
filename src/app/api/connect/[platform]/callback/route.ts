import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getSessionUser } from "@/lib/session";
import { db, schema } from "@/db";
import { socialAccounts } from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";
import { PLATFORM_REGISTRY, type PlatformId } from "@/lib/platforms";
import { requestOrigin, safeReturnPath } from "@/lib/request-origin";
import { readPlatformAppCredentials } from "@/lib/platform-credentials";
import {
  exchangeForLongLivedToken,
  supportsLongLivedToken,
} from "@/lib/platform-tokens";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  const { platform: platformIdStr } = await params;
  const platform = PLATFORM_REGISTRY[platformIdStr as PlatformId];
  if (!platform) {
    return NextResponse.redirect(new URL("/accounts?error=unknown_platform", req.url));
  }

  const verifierCookieName = `pkce_${platformIdStr}`;

  /**
   * Send the browser back into the app and drop the verifier cookie. Setting
   * the cookie on the response is the only way to clear it — mutating
   * `req.cookies` has no effect on what the browser receives.
   */
  const respond = (target: string): NextResponse => {
    const res = NextResponse.redirect(new URL(target, req.url));
    res.cookies.set(verifierCookieName, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });
    return res;
  };

  const fail = (reason: string) =>
    respond(`/accounts?error=${encodeURIComponent(reason)}`);

  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const stateStr = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) return fail(error);
  if (!code || !stateStr) return fail("missing_code_or_state");

  // The session is resolved before any credential is read: app credentials come
  // from the signed-in user's own rows, never from another account's rows.
  const session = await getSessionUser();
  if (!session) return NextResponse.redirect(new URL("/login", req.url));

  let state: { userId?: string; returnUrl?: string };
  try {
    state = JSON.parse(Buffer.from(stateStr, "base64url").toString());
  } catch {
    return fail("invalid_state");
  }
  if (state.userId !== session.id) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  // `state` round-trips through the browser, so the return path is validated
  // again here (same-origin only) before it is used as a redirect target.
  const returnUrl = safeReturnPath(state.returnUrl);

  const credentials = await readPlatformAppCredentials(session.id, platform.id);
  if (!credentials) return fail("credentials_missing");
  const { clientId, clientSecret } = credentials;

  const codeVerifier = req.cookies.get(verifierCookieName)?.value ?? "";
  if (!codeVerifier) return fail("missing_pkce_verifier");

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
    return fail(`token_exchange_failed:${tokenRes.status}`);
  }

  const tokenData = (await tokenRes.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    user_id?: string;
    username?: string;
  };

  if (!tokenData.access_token) {
    return fail("no_access_token");
  }

  // Instagram and Threads issue a 1-hour token here. Upgrade it to the 60-day
  // long-lived token now — otherwise the connection dies within the hour and
  // publishing starts failing with an expired-token error.
  let accessToken = tokenData.access_token;
  let expiresIn = tokenData.expires_in ?? null;

  if (supportsLongLivedToken(platform.id)) {
    const longLived = await exchangeForLongLivedToken(
      platform.id,
      accessToken,
      clientSecret
    );
    if (longLived) {
      accessToken = longLived.accessToken;
      expiresIn = longLived.expiresIn ?? expiresIn;
    }
  }

  // Fetch profile
  let profileUsername: string | undefined;
  let platformAccountId: string | undefined;

  if (platformIdStr === "instagram") {
    const profileRes = await fetch(
      `https://graph.instagram.com/me?fields=username,account_type&access_token=${encodeURIComponent(accessToken)}`
    );
    if (profileRes.ok) {
      const profile = (await profileRes.json()) as {
        username?: string;
        id?: string;
        account_type?: string;
      };
      profileUsername = profile.username;
      platformAccountId = profile.id;
      if (profile.account_type === "NONE") {
        return fail("instagram_personal_only");
      }
    }
  } else if (platformIdStr === "threads") {
    const profileRes = await fetch(
      `https://graph.threads.net/me?fields=username&access_token=${encodeURIComponent(accessToken)}`
    );
    if (profileRes.ok) {
      const profile = (await profileRes.json()) as { username?: string; id?: string };
      profileUsername = profile.username;
      platformAccountId = profile.id;
    }
  }

  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

  // Reconnecting replaces the connection. Appending instead would leave the
  // previous row in place and let the publish path pick up a stale token.
  await db
    .delete(socialAccounts)
    .where(
      and(
        eq(socialAccounts.userId, session.id),
        eq(socialAccounts.platform, platformIdStr)
      )
    );

  await db.insert(schema.socialAccounts).values({
    id: randomUUID(),
    userId: session.id,
    platform: platformIdStr,
    platformAccountId: platformAccountId ?? tokenData.user_id ?? "unknown",
    username: profileUsername ?? tokenData.username ?? null,
    accessTokenEnc: encryptSecret(accessToken),
    refreshTokenEnc: tokenData.refresh_token ? encryptSecret(tokenData.refresh_token) : null,
    tokenExpiresAt: expiresAt,
  });

  return respond(
    `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}connected=${encodeURIComponent(platformIdStr)}`
  );
}