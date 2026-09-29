import "server-only";

import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db";
import { accounts, connections } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import {
  DEFAULT_TOKEN_LIFETIME_SECONDS,
  effectiveTokenExpiry,
  isExpiredSessionError,
  refreshLongLivedToken,
  supportsTokenRefresh,
  TOKEN_REFRESH_WINDOW_MS,
  tokenExpiredMessage,
} from "@/lib/platform-tokens";

/**
 * Graph API hosts.
 *
 * Tokens minted by the Instagram API with Instagram Login are only accepted by
 * `graph.instagram.com`; Facebook Page tokens only by `graph.facebook.com`.
 * Posting an Instagram Login token to the Facebook host fails every time.
 */
export const GRAPH_FACEBOOK = "https://graph.facebook.com/v26.0";
export const GRAPH_INSTAGRAM = "https://graph.instagram.com/v25.0";
export const GRAPH_THREADS = "https://graph.threads.net/v1.0";

export interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number };
}

/** A connection that is stored but cannot publish, and why. */
type ConnectionProblem = "not_connected" | "expired";

type AccountLookup =
  | { ok: true; accessToken: string; platformAccountId: string }
  | { ok: false; problem: ConnectionProblem };

/** Publish failure for an unusable connection — the two cases worth naming. */
export function connectionError(platform: string, problem: ConnectionProblem): string {
  const name = platform.charAt(0).toUpperCase() + platform.slice(1);
  return problem === "expired" ? tokenExpiredMessage(platform) : `${name} not connected`;
}

/**
 * Read the platform's own message out of a Graph error, rephrasing the one
 * case where we know the fix better than Meta's wording does: an expired
 * session, which Meta reports verbatim as `Error validating access token:
 * Session has expired on …` and which only a reconnect can repair.
 */
export function graphErrorMessage(platform: string, err: GraphError, fallback: string): string {
  if (isExpiredSessionError(err)) return tokenExpiredMessage(platform);
  return err.error?.message || fallback;
}

/** Errors surface as `unknown` — read a message out of them without `any`. */
export function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** Sleep helper for the container processing polls. */
export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Load the connection for a platform. Newest row wins, so a connection made
 * before reconnects replaced rows instead of appending them can't shadow it.
 *
 * Returns `{ ok: false, problem }` for the two states a publish cannot work
 * from — no connection, or one whose session has expired — and refreshes the
 * long-lived token on the way out when it is inside `TOKEN_REFRESH_WINDOW_MS`.
 * Nothing else ever acts on `tokenExpiresAt`, so without this check the
 * connection would silently die ~60 days after connect.
 */
export async function getConnectedAccount(
  userId: string,
  platform: string,
  accountKey?: string | null
): Promise<AccountLookup> {
  // Resolves through `accounts` -> `connections` (ADR-006). This used to read
  // `social_accounts` and take `.limit(1)` by newest `connected_at`, so the most
  // recently connected account always won.
  const candidates = await db
    .select({
      connectionId: accounts.connectionId,
      platformAccountId: accounts.platformAccountId,
      accessTokenEnc: connections.accessTokenEnc,
      tokenExpiresAt: connections.tokenExpiresAt,
      connectedAt: connections.connectedAt,
    })
    .from(accounts)
    .innerJoin(connections, eq(accounts.connectionId, connections.id))
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.platform, platform),
        ...(accountKey
          ? [eq(accounts.accountKey, accountKey)]
          : [eq(accounts.enabled, true)]),
      ),
    )
    .orderBy(desc(connections.connectedAt));

  // An explicit key that resolves to nothing is a caller error and must not
  // fall back to some other account.
  if (accountKey && candidates.length === 0) {
    return { ok: false, problem: "not_connected" };
  }

  // No key: exactly one enabled account is unambiguous. Several means the
  // caller must say which — guessing is how a post lands on the wrong account.
  if (!accountKey && candidates.length !== 1) {
    return { ok: false, problem: "not_connected" };
  }

  const account = candidates[0];
  if (!account?.accessTokenEnc) return { ok: false, problem: "not_connected" };

  let accessToken: string;
  try {
    accessToken = decryptSecret(account.accessTokenEnc);
  } catch {
    return { ok: false, problem: "not_connected" };
  }

  // Nothing else ever acts on `tokenExpiresAt`, so this is the only place a
  // connection notices it is running out. An expired token is reported here
  // rather than sent to the platform: Meta would answer with the same verdict
  // (`code 190 / subcode 463`), only later and in its own words.
  const expiresAt = effectiveTokenExpiry(platform, account.tokenExpiresAt, account.connectedAt);
  if (expiresAt) {
    const msLeft = expiresAt.getTime() - Date.now();
    if (msLeft <= 0) return { ok: false, problem: "expired" };

    if (msLeft < TOKEN_REFRESH_WINDOW_MS && supportsTokenRefresh(platform)) {
      const refreshed = await refreshLongLivedToken(platform, accessToken);
      if (refreshed) {
        accessToken = refreshed.accessToken;
        const newExpiry = new Date(
          Date.now() +
            (refreshed.expiresIn ?? DEFAULT_TOKEN_LIFETIME_SECONDS) * 1000
        );
        await db
          .update(connections)
          .set({
            accessTokenEnc: encryptSecret(accessToken),
            tokenExpiresAt: newExpiry,
          })
          .where(eq(connections.id, account.connectionId));
      }
      // A failed refresh keeps the still-valid old token: the window is wide
      // enough that the next publish or cron run gets another attempt.
    }
  }

  return { ok: true, accessToken, platformAccountId: account.platformAccountId };
}

