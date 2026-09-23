import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";

import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * Stateless JWT sessions stored in httpOnly cookies.
 *
 * - HS256 signed with AUTH_SECRET
 * - 7-day expiry, sliding window (refreshed on every authenticated request)
 * - Cookie is set before any redirect to prevent race conditions
 * - Versioned: tokens carry `ver` = users.token_version, and getSessionUser
 *   compares it against the row — bumping the column revokes every
 *   outstanding cookie at once (password changes do this)
 */

const SESSION_COOKIE = "hilbras_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function getSecretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET must be set in production");
  }
  return new TextEncoder().encode(
    secret ?? "dev-only-insecure-secret-do-not-use-in-prod"
  );
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  username: string;
}

/**
 * Issue a session cookie for the given user id.
 * Returns the token so callers can verify it was set.
 */
export async function createSession(userId: string): Promise<string> {
  // The version travels inside the token so getSessionUser can reject
  // anything signed before a bump — see the module docs above.
  const [row] = await db
    .select({ tokenVersion: users.tokenVersion })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const token = await new SignJWT({ sub: userId, ver: row?.tokenVersion ?? 0 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSecretKey());

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });

  return token;
}

/** Clear the session cookie. */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** Resolve the current user from the session cookie, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    if (typeof payload.sub !== "string") return null;

    const [user] = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        username: users.username,
        tokenVersion: users.tokenVersion,
      })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);

    if (!user) return null;

    // Revocation: a bumped token_version invalidates every cookie signed
    // with an older number. Tokens issued before versioning carry no claim
    // and count as 0 (the column's default).
    const claimed = typeof payload.ver === "number" ? payload.ver : 0;
    if (claimed !== user.tokenVersion) return null;

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      username: user.username,
    };
  } catch {
    return null;
  }
}

/** Server-component guard: redirect to /login when unauthenticated. */
export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  // Reaching this guard at all means the proxy already accepted the cookie's
  // signature — a null user here means it failed server-side validation
  // (revoked version / deleted account). ?reauth=1 tells the proxy to clear
  // it, which is what stops a redirect loop with the proxy's own rules.
  if (!user) redirect("/login?reauth=1");
  return user;
}
