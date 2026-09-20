import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const SESSION_COOKIE = "hilbras_session";
const PROTECTED = ["/dashboard", "/assistant", "/accounts", "/composer", "/scheduler", "/inbox", "/analytics", "/settings"];
const AUTH_PAGES = ["/login", "/signup"];

function getSecretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  return new TextEncoder().encode(secret ?? "dev-only-insecure-secret-do-not-use-in-prod");
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value;

  const isProtected = PROTECTED.some((p) => pathname.startsWith(p));
  const isAuthPage = AUTH_PAGES.some((p) => pathname.startsWith(p));

  let sessionValid = false;
  let needsRefresh = false;
  let userId = "";

  if (token) {
    try {
      const { payload } = await jwtVerify(token, getSecretKey());
      if (typeof payload.sub === "string") {
        sessionValid = true;
        userId = payload.sub;

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

  // Refresh the session cookie if nearing expiry
  if (sessionValid && needsRefresh) {
    const { SignJWT } = await import("jose");
    const newToken = await new SignJWT({ sub: userId })
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
