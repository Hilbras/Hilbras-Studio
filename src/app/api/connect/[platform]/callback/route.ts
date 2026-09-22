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
import { isThreadsPermissionError } from "@/lib/threads-errors";
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

  // Meta reports a redirect URI that is not registered on the `error_code`
  // parameter (1349168 "URL Blocked"), with `error` often absent — without this
  // the browser would land back on /accounts with an empty banner.
  const errorCode = searchParams.get("error_code");
  if (errorCode === "1349168") return fail("url_blocked");

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

  // Token exchange. Meta documents Facebook's `/oauth/access_token` as a GET
  // with the parameters in the query string (manual-flow + PKCE guides) and no
  // grant_type; Threads and Instagram document the form-encoded POST with
  // grant_type that is the default below. The PKCE verifier is only required
  // when no client_secret is sent, so its absence on the Facebook branch is
  // per the docs, not a dropped safeguard.
  const redirectUri = `${requestOrigin(req)}/api/connect/${platformIdStr}/callback`;
  const useGet = platform.auth.tokenMethod === "get";

  const tokenRes = useGet
    ? await fetch(
        (() => {
          const u = new URL(platform.auth.tokenUrl);
          u.searchParams.set("client_id", clientId);
          u.searchParams.set("redirect_uri", redirectUri);
          u.searchParams.set("client_secret", clientSecret);
          u.searchParams.set("code", code);
          return u.toString();
        })(),
        { headers: platform.auth.extraHeaders },
      )
    : await fetch(platform.auth.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...platform.auth.extraHeaders,
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
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

  // Instagram, Threads and Facebook issue a 1-hour token here. Upgrade it to
  // the 60-day long-lived token now — otherwise the connection dies within the
  // hour and publishing starts failing with an expired-token error.
  let accessToken = tokenData.access_token;
  let expiresIn = tokenData.expires_in ?? null;

  if (supportsLongLivedToken(platform.id)) {
    const longLived = await exchangeForLongLivedToken(
      platform.id,
      accessToken,
      clientSecret,
      clientId
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
    } else {
      // Meta issues a token even when the app user ended up granting nothing, and
      // then every Threads call fails with code 100 / error_subcode 10 ("This
      // action requires the threads_basic permission"). This profile call — the
      // first one made with the new token — is where that becomes visible, and
      // `GET /me` needs no more than `threads_basic`, which every Threads grant
      // includes. So a failure here means the account has no grant at all (not an
      // accepted Threads Tester yet, or the app is unpublished without App
      // Review): report it instead of storing a connection that can only fail.
      // Other failures keep the old behaviour of connecting without a username.
      const errorPayload = await profileRes.json().catch(() => null);
      if (isThreadsPermissionError(errorPayload)) {
        return fail("threads_permissions_not_granted");
      }
    }
  } else if (platformIdStr === "facebook") {
    // The code exchange does not reliably return a user id, and the publish
    // path identifies the account through `/me/accounts` — so read the id (and
    // the display name) straight from the Graph API instead of storing
    // "unknown".
    const profileRes = await fetch(
      `https://graph.facebook.com/v26.0/me?fields=id,name&access_token=${encodeURIComponent(accessToken)}`
    );
    if (profileRes.ok) {
      const profile = (await profileRes.json()) as { id?: string; name?: string };
      platformAccountId = profile.id;
      profileUsername = profile.name;
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