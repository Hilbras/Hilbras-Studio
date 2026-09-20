import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { PLATFORM_REGISTRY, type PlatformId } from "@/lib/platforms";
import { requestOrigin, safeReturnPath } from "@/lib/request-origin";
import { readPlatformAppCredentials } from "@/lib/platform-credentials";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  const { platform: platformIdStr } = await params;
  const platform = PLATFORM_REGISTRY[platformIdStr as PlatformId];
  if (!platform) return NextResponse.json({ error: "unknown platform" }, { status: 400 });

  const session = await getSessionUser();
  if (!session) return NextResponse.redirect(new URL("/login", req.url));

  // Credentials belong to the signed-in user: their own Settings → Accounts row
  // first, then the platform's env vars. Never another user's row — the client
  // secret is used to mint this user's token.
  const credentials = await readPlatformAppCredentials(session.id, platform.id);
  if (!credentials) {
    return NextResponse.redirect(
      new URL("/accounts?error=credentials_not_configured", req.url)
    );
  }
  const { clientId } = credentials;

  // The Referer is attacker-controllable, so only its path is kept as the
  // post-callback destination (see `safeReturnPath`).
  const returnUrl = safeReturnPath(
    req.headers.get("referer"),
    `${requestOrigin(req)}/accounts`
  );
  const state = Buffer.from(JSON.stringify({ userId: session.id, returnUrl })).toString("base64url");

  const codeVerifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const hashed = await crypto.subtle.digest("SHA-256", Buffer.from(codeVerifier));
  const codeChallenge = Buffer.from(hashed).toString("base64url").replace(/=/g, "");

  const verifierCookieName = `pkce_${platformIdStr}`;
  const redirectUri = `${requestOrigin(req)}/api/connect/${platformIdStr}/callback`;
  const response = NextResponse.redirect(
    `${platform.auth.authorizeUrl}?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(platform.auth.scopes.join(" "))}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256`
  );

  response.cookies.set(verifierCookieName, codeVerifier, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 10,
    path: "/",
  });

  return response;
}