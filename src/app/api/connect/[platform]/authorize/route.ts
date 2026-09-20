import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { PLATFORM_REGISTRY, type PlatformId } from "@/lib/platforms";
import { db } from "@/db";
import { storedCredentials } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requestOrigin } from "@/lib/request-origin";

/** Read credential directly from DB without session check. */
async function readCredentialDirect(keyName: string): Promise<string | null> {
  const [row] = await db
    .select({ encryptedValue: storedCredentials.encryptedValue })
    .from(storedCredentials)
    .where(eq(storedCredentials.keyName, keyName))
    .limit(1);
  if (!row?.encryptedValue) return null;
  try {
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
  if (!platform) return NextResponse.json({ error: "unknown platform" }, { status: 400 });

  // Read from DB directly, fallback to env
  const clientId = await readCredentialDirect(`${platformIdStr}_client_id`);
  const clientSecret = await readCredentialDirect(`${platformIdStr}_client_secret`);

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(
      new URL("/accounts?error=credentials_not_configured", req.url)
    );
  }

  const session = await getSessionUser();
  if (!session) return NextResponse.redirect(new URL("/login", req.url));

  const returnUrl = req.headers.get("referer") || `${requestOrigin(req)}/accounts`;
  const state = Buffer.from(JSON.stringify({ userId: session.id, returnUrl })).toString("base64url");

  const codeVerifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const hashed = await crypto.subtle.digest("SHA-256", Buffer.from(codeVerifier));
  const codeChallenge = Buffer.from(hashed).toString("base64url").replace(/=/g, "");

  const verifierCookieName = `pkce_${platformIdStr}`;
  const redirectUri = `${requestOrigin(req)}/api/connect/${platformIdStr}/callback`;
  console.log("[OAuth] redirect_uri:", redirectUri);
  console.log("[OAuth] headers:", JSON.stringify({
    proto: req.headers.get("x-forwarded-proto"),
    host: req.headers.get("x-forwarded-host"),
    hostHeader: req.headers.get("host"),
    reqUrl: req.url,
  }));
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