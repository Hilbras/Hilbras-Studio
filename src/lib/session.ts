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
 */

const SESSION_COOKIE = "hilbras_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const REFRESH_THRESHOLD_SECONDS = 60 * 60 * 24; // refresh if < 1 day left

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
  const token = await new SignJWT({ sub: userId })
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

/**
 * Refresh the session cookie if it's nearing expiry.
 * Call this on every authenticated request for sliding-window behavior.
 */
export async function refreshSessionIfNeeded(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return;

  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    if (typeof payload.sub !== "string") return;

    // Check if the token needs refreshing
    const exp = payload.exp;
    const iat = payload.iat;
    if (!exp || !iat) return;

    const remaining = exp - Math.floor(Date.now() / 1000);
    if (remaining > REFRESH_THRESHOLD_SECONDS) return;

    // Token is near expiry — issue a fresh one
    const newToken = await new SignJWT({ sub: payload.sub })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
      .sign(getSecretKey());

    store.set(SESSION_COOKIE, newToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
  } catch {
    // Invalid token — clear it
    store.delete(SESSION_COOKIE);
  }
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
      })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);

    return user ?? null;
  } catch {
    return null;
  }
}

/** Server-component guard: redirect to /login when unauthenticated. */
export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}
