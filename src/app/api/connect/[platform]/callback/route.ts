import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { registerConnection } from "@/lib/accounts/store";
import { encryptSecret } from "@/lib/crypto";
import { PLATFORM_REGISTRY, type PlatformId } from "@/lib/platforms";
import { requestOrigin, safeReturnPath } from "@/lib/request-origin";
import { readPlatformAppCredentials } from "@/lib/platform-credentials";
import { isThreadsPermissionError } from "@/lib/threads-errors";
import { verifyState } from "@/lib/oauth-state";
import { fetchPlatformProfile, hasProfileLookup } from "@/lib/oauth-profile";
import { getSecretKey } from "@/lib/secret-key";
import { fetchWithTimeout } from "@/lib/http";
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
    return NextResponse.redirect(
      new URL("/settings/credentials?error=unknown_platform", req.url),
    );
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

  // A failure returns to the page that *started* the flow, because that is
  // where the thing to fix lives. Phase 7 moved the app-credentials form and
  // the connect button to `/settings/credentials` and gave `/accounts` over to
  // connected accounts, so a failure banner on the accounts list would be a
  // complaint with no remedy on the screen showing it.
  const fail = (reason: string) =>
    respond(`/settings/credentials?error=${encodeURIComponent(reason)}`);

  // Manual platforms (Telegram) never round-trip through this OAuth callback —
  // their connection is written by the Accounts modal's own action. Anything
  // else without an `auth` block cannot have come from this flow either.
  if (platform.connection === "manual" || !platform.auth) {
    return fail("manual_connection");
  }

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

  // Verified before it is trusted, and the verification is the boundary — not
  // the userId comparison below, which used to be the *only* check. Until
  // v0.9.5 the state was unsigned base64url JSON, so `state.userId === session.id`
  // was a check an attacker could satisfy by knowing the victim's id, which
  // links the attacker's social account to the victim's account. A state that
  // did not come from our own `/authorize` is now rejected on its signature.
  const state = verifyState(stateStr, getSecretKey());
  if (!state || state.userId !== session.id) {
    return fail("invalid_state");
  }

  // `state` round-trips through the browser, so the return path is validated
  // again here (same-origin only) before it is used as a redirect target.
  const returnUrl = safeReturnPath(state.returnUrl);

  const credentials = await readPlatformAppCredentials(session.id, platform.id);
  if (!credentials) return fail("credentials_missing");
  const { clientId, clientSecret } = credentials;

  const codeVerifier = req.cookies.get(verifierCookieName)?.value ?? "";
  // PKCE policy: every flow whose token exchange can carry a verifier issues a
  // challenge in /authorize and must present it here. The one exception is the
  // GET exchange (Facebook), whose documented parameter list has no
  // code_verifier — so /authorize issues no challenge for it either.
  const pkceExpected = platform.auth.tokenMethod !== "get";
  if (pkceExpected && !codeVerifier) return fail("missing_pkce_verifier");

  // Token exchange. Meta documents Facebook's `/oauth/access_token` as a GET
  // with the parameters in the query string (manual-flow + PKCE guides) and no
  // grant_type; Threads and Instagram document the form-encoded POST with
  // grant_type that is the default below. Platforms with `tokenAuth: "basic"`
  // (X, Reddit) authenticate the exchange with HTTP Basic credentials and must
  // not send the client secret in the body.
  const redirectUri = `${requestOrigin(req)}/api/connect/${platformIdStr}/callback`;
  const useGet = platform.auth.tokenMethod === "get";
  const useBasicAuth = platform.auth.tokenAuth === "basic";

  const tokenRes = useGet
    ? await fetchWithTimeout(
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
    : await fetchWithTimeout(platform.auth.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(useBasicAuth
            ? {
                Authorization: `Basic ${Buffer.from(
                  `${clientId}:${clientSecret}`,
                ).toString("base64")}`,
              }
            : {}),
          ...platform.auth.extraHeaders,
        },
        body: new URLSearchParams({
          // The Basic header carries the app credentials where they would be
          // rejected in the body (X: "Client authentication failed" when the
          // secret is posted; Reddit likewise authenticates via Basic only).
          ...(useBasicAuth ? {} : { client_id: clientId, client_secret: clientSecret }),
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          ...(pkceExpected ? { code_verifier: codeVerifier } : {}),
        }).toString(),
      });

  if (!tokenRes.ok) {
    return fail(`token_exchange_failed:${tokenRes.status}`);
  }

  // Meta documents this response both flat and wrapped in `data` — Instagram's
  // Business Login guide shows the wrapped form — so take whichever is there.
  const rawToken = (await tokenRes.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const wrappedToken = (
    rawToken.data as Array<Record<string, unknown>> | undefined
  )?.[0];
  const tokenData = (rawToken.access_token
    ? rawToken
    : (wrappedToken ?? rawToken)) as {
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
    // `user_id` is the Instagram professional-account ID (`<IG_ID>`) that every
    // publish endpoint takes; `id` is only the app-scoped ID. Meta's guide also
    // shows the response wrapped in `data` — accept either shape.
    const profileRes = await fetchWithTimeout(
      `https://graph.instagram.com/me?fields=user_id,username,account_type&access_token=${encodeURIComponent(accessToken)}`
    );
    if (profileRes.ok) {
      const body = (await profileRes.json()) as {
        data?: Array<{
          id?: string;
          user_id?: string;
          username?: string;
          account_type?: string;
        }>;
        id?: string;
        user_id?: string;
        username?: string;
        account_type?: string;
      };
      const profile = body.data?.[0] ?? body;
      profileUsername = profile.username;
      platformAccountId = profile.user_id ?? profile.id;
      if (profile.account_type === "NONE") {
        return fail("instagram_personal_only");
      }
    }
  } else if (platformIdStr === "threads") {
    const profileRes = await fetchWithTimeout(
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
    const profileRes = await fetchWithTimeout(
      `https://graph.facebook.com/v26.0/me?fields=id,name&access_token=${encodeURIComponent(accessToken)}`
    );
    if (profileRes.ok) {
      const profile = (await profileRes.json()) as { id?: string; name?: string };
      platformAccountId = profile.id;
      profileUsername = profile.name;
    }
  } else if (hasProfileLookup(platformIdStr)) {
    // X, Reddit, LinkedIn, TikTok, YouTube, Pinterest: one documented
    // /me-shaped endpoint each, resolved with the freshly minted token.
    const profile = await fetchPlatformProfile(platformIdStr, accessToken);
    if (profile) {
      platformAccountId = profile.id;
      profileUsername = profile.handle ?? undefined;
    }
  }

  // A connect without a platform account id cannot be keyed, repointed on
  // reconnect, or addressed by anything downstream. It used to be stored as
  // `"unknown"`, which silently collapsed every identity on the platform onto
  // one row — so an unresolvable profile now fails the connect with an error
  // the user can act on (retry, or fix the app configuration).
  if (!platformAccountId) {
    return fail("profile_unavailable");
  }

  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

  // Records the grant and the account it identifies (ADR-006). This never
  // deletes: a reconnect repoints the existing account at the fresh grant, so
  // other accounts on the same platform survive. The previous code deleted every
  // row for (user, platform) first, which destroyed them.
  await registerConnection({
    userId: session.id,
    platform: platformIdStr,
    accessTokenEnc: encryptSecret(accessToken),
    refreshTokenEnc: tokenData.refresh_token
      ? encryptSecret(tokenData.refresh_token)
      : null,
    tokenExpiresAt: expiresAt,
    accounts: [
      {
        platformAccountId,
        handle: profileUsername ?? tokenData.username ?? null,
      },
    ],
  });

  return respond(
    `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}connected=${encodeURIComponent(platformIdStr)}`
  );
}