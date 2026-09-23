import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const SESSION_COOKIE = "hilbras_session";
const PROTECTED = ["/dashboard", "/assistant", "/accounts", "/composer", "/scheduler", "/inbox", "/analytics", "/settings"];
const AUTH_PAGES = ["/login", "/signup"];

/**
 * Same rule as getSecretKey in lib/session.ts: production must never fall
 * back to a shared hardcoded key — a forgotten AUTH_SECRET fails loudly
 * instead of minting sessions anyone can forge.
 */
function getSecretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET must be set in production");
  }
  return new TextEncoder().encode(
    secret ?? "dev-only-insecure-secret-do-not-use-in-prod"
  );
}

/**
 * Best-effort burst throttle for auth form posts (server-action submissions
 * to /login and /signup land here as POSTs too).
 *
 * Serverless instances don't share memory, so this brakes bursts on a warm
 * instance rather than enforcing a hard global quota — the durable,
 * per-account protection is the failed-attempt lockout in signInAction.
 */
const AUTH_POST_LIMIT = 10;
const AUTH_POST_WINDOW_MS = 60_000;
const AUTH_POST_TRACK_CAP = 10_000;
const authPostHits = new Map<string, number[]>();

function allowAuthPost(key: string): boolean {
  const now = Date.now();
  const hits = (authPostHits.get(key) ?? []).filter(
    (t) => now - t < AUTH_POST_WINDOW_MS
  );
  if (hits.length >= AUTH_POST_LIMIT) {
    authPostHits.set(key, hits);
    return false;
  }
  hits.push(now);
  if (authPostHits.size >= AUTH_POST_TRACK_CAP) authPostHits.clear();
  authPostHits.set(key, hits);
  return true;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    request.method === "POST" &&
    (pathname === "/login" || pathname === "/signup")
  ) {
    // On Vercel the platform owns x-forwarded-for; a spoofed first hop only
    // lets an attacker shuffle their own throttle buckets — the DB lockout
    // keyed to the account does not depend on the IP at all.
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";
    if (!allowAuthPost(`${pathname}:${ip}`)) {
      return new NextResponse(
        "Too many requests — wait a minute and try again.",
        {
          status: 429,
          headers: {
            "Retry-After": "60",
            "Content-Type": "text/plain; charset=utf-8",
          },
        }
      );
    }
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;

  const isProtected = PROTECTED.some((p) => pathname.startsWith(p));
  const isAuthPage = AUTH_PAGES.some((p) => pathname.startsWith(p));

  let sessionValid = false;
  let needsRefresh = false;
  let userId = "";
  let tokenVersion = 0;

  if (token) {
    try {
      const { payload } = await jwtVerify(token, getSecretKey());
      if (typeof payload.sub === "string") {
        sessionValid = true;
        userId = payload.sub;
        tokenVersion = typeof payload.ver === "number" ? payload.ver : 0;

        const exp = payload.exp;
        const iat = payload.iat;
        if (exp && iat) {
          const remaining = exp - Math.floor(Date.now() / 1000);
          if (remaining < 60 * 60 * 24) {
            needsRefresh = true;
          }
        }
      }
    } catch {
      sessionValid = false;
    }
  }

  // A signed-but-dead cookie (password changed elsewhere, user deleted, or
  // token_version bumped) passes this proxy's signature check but fails
  // getSessionUser inside the layout, which redirects to /login?reauth=1.
  // Clear the cookie here: without it the two layers bounce the browser
  // between /login and /dashboard forever.
  if (isAuthPage && request.nextUrl.searchParams.get("reauth") === "1") {
    const response = NextResponse.redirect(new URL("/login", request.url));
    response.cookies.delete(SESSION_COOKIE);
    return response;
  }

  // Redirect unauthenticated users away from protected routes
  if (isProtected && !sessionValid) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Redirect authenticated users away from auth pages
  if (isAuthPage && sessionValid) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  // Refresh the session cookie if nearing expiry. The version claim is
  // carried forward verbatim — the data layer (getSessionUser) is what
  // compares it against users.token_version, so the proxy re-signs only
  // what it was given and never invents a fresh version.
  if (sessionValid && needsRefresh) {
    const { SignJWT } = await import("jose");
    const newToken = await new SignJWT({ sub: userId, ver: tokenVersion })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(getSecretKey());

    const response = NextResponse.next();
    response.cookies.set(SESSION_COOKIE, newToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/assistant/:path*",
    "/accounts/:path*",
    "/composer/:path*",
    "/scheduler/:path*",
    "/inbox/:path*",
    "/analytics/:path*",
    "/settings/:path*",
    "/login",
    "/signup",
  ],
};
