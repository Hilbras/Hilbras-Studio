import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { socialAccounts } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import {
  DEFAULT_TOKEN_LIFETIME_SECONDS,
  effectiveTokenExpiry,
  refreshablePlatforms,
  refreshLongLivedToken,
  TOKEN_REFRESH_WINDOW_MS,
} from "@/lib/platform-tokens";

/**
 * Proactive token maintenance.
 *
 * Until now a long-lived token was only refreshed as a side effect of a publish
 * inside its last few days — so a platform nobody posted to for 60 days, or a
 * post scheduled outside that window, ended with an expired token that Meta
 * refuses to refresh and no publish error to explain why. Running the same
 * refresh from the cron means the token is renewed while it is still valid,
 * whether or not anything is being published, and a single failed attempt is
 * retried on the next run instead of being fatal.
 *
 * Safe to run often: a token only leaves the scan when it was refreshed (a new
 * 60 days) or it is already past expiry, where the honest answer is a reconnect
 * — which the Accounts page now reports from `checkConnectionHealth`.
 */

export interface TokenRefreshSummary {
  /** Rows scanned — every stored connection of a refreshable platform. */
  scanned: number;
  /** Tokens inside the refresh window that were renewed. */
  refreshed: number;
  /** Tokens inside the window whose refresh attempt failed (retried next run). */
  failed: number;
  /** Tokens already expired: not refreshable, left for the reconnect prompt. */
  expired: number;
}

/**
 * Refresh every stored token that is inside `TOKEN_REFRESH_WINDOW_MS` of
 * expiring, optionally scoped to one user (the Scheduler's on-demand run keeps
 * to the signed-in user's rows, like the rest of that path).
 *
 * Runs before publishing so due posts pick up the fresh token on the very same
 * invocation.
 */
export async function refreshExpiringTokens(userId?: string): Promise<TokenRefreshSummary> {
  const summary: TokenRefreshSummary = { scanned: 0, refreshed: 0, failed: 0, expired: 0 };
  const refreshable = refreshablePlatforms();
  if (refreshable.length === 0) return summary;

  const conditions = [inArray(socialAccounts.platform, refreshable)];
  if (userId) conditions.push(eq(socialAccounts.userId, userId));

  const rows = await db
    .select({
      id: socialAccounts.id,
      platform: socialAccounts.platform,
      accessTokenEnc: socialAccounts.accessTokenEnc,
      tokenExpiresAt: socialAccounts.tokenExpiresAt,
      connectedAt: socialAccounts.connectedAt,
    })
    .from(socialAccounts)
    .where(and(...conditions));

  const now = Date.now();

  for (const row of rows) {
    summary.scanned++;
    if (!row.accessTokenEnc) continue;

    const expiresAt = effectiveTokenExpiry(row.platform, row.tokenExpiresAt, row.connectedAt);
    if (!expiresAt) continue;

    const msLeft = expiresAt.getTime() - now;
    if (msLeft <= 0) {
      // Already dead: Meta will not refresh it, and inventing a new expiry
      // would only hide the state the Accounts page is meant to surface.
      summary.expired++;
      continue;
    }
    if (msLeft >= TOKEN_REFRESH_WINDOW_MS) continue;

    let token: string;
    try {
      token = decryptSecret(row.accessTokenEnc);
    } catch {
      // An undecryptable token says nothing about the platform — leave it to
      // the health probe rather than counting it as a failed refresh.
      continue;
    }

    const refreshed = await refreshLongLivedToken(row.platform, token);
    if (!refreshed) {
      summary.failed++;
      continue;
    }

    await db
      .update(socialAccounts)
      .set({
        accessTokenEnc: encryptSecret(refreshed.accessToken),
        tokenExpiresAt: new Date(
          now + (refreshed.expiresIn ?? DEFAULT_TOKEN_LIFETIME_SECONDS) * 1000
        ),
      })
      .where(eq(socialAccounts.id, row.id));

    summary.refreshed++;
  }

  return summary;
}
