import "server-only";

import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { socialAccounts } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import {
  isExpiredSessionError,
  effectiveTokenExpiry,
} from "@/lib/platform-tokens";
import { isThreadsPermissionError } from "@/lib/threads-errors";

/**
 * Two ways a stored connection can look healthy and be unable to publish.
 * Both are reported separately from `connected`, which only says a row exists.
 *
 * 1. **No permission grant** (Threads only): Meta issues a Threads access token
 *    even when the app user granted nothing (no accepted Threads Tester role, or
 *    an app whose permissions never passed App Review), and then rejects *every*
 *    endpoint of that token with code 100 / `error_subcode` 10 — including
 *    `GET /me`, which needs no more than `threads_basic`. `check-connections`
 *    used to answer "connected" for such a row, so the Accounts card stayed
 *    green while the first publish failed. The grant cannot be repaired: it is
 *    bound to the token it was issued for, and accepting the tester invitation is
 *    not retroactive — the only way out is a fresh authorization, which is why
 *    the Accounts page turns this verdict into a Reconnect prompt. See
 *    `docs/THREADS_SETUP.md`.
 *
 * 2. **Expired session** (any platform): the stored token ran out because
 *    nothing refreshed it in time. Meta only refreshes a token that is still
 *    valid, so this too is unrecoverable without a new authorization — and the
 *    platform would otherwise only reveal it at publish time, in its own words
 *    ("Error validating access token: Session has expired on …").
 */
const GRAPH_THREADS = "https://graph.threads.net/v1.0";

/** Budget for the probe. A slow answer means "unknown", never "broken". */
const PROBE_TIMEOUT_MS = 3_000;

export interface ConnectionHealth {
  /** Platforms whose stored connection provably carries no permission grant. */
  permissionsMissing: string[];
  /** Platforms whose stored session has expired and needs a reconnect. */
  expired: string[];
}

/**
 * Classify every stored connection: which ones are unusable, and why.
 *
 * Deliberately conservative: only a *definitive* verdict — a passed timestamp or
 * a definitive rejection by the platform — puts a platform in either list. A
 * timeout, an undecryptable token or a 5xx leaves it out, because a probe that
 * could not run says nothing about the connection, and a false "reconnect"
 * prompt is worse than none.
 */
export async function checkConnectionHealth(userId: string): Promise<ConnectionHealth> {
  const rows = await db
    .select({
      platform: socialAccounts.platform,
      accessTokenEnc: socialAccounts.accessTokenEnc,
      tokenExpiresAt: socialAccounts.tokenExpiresAt,
      connectedAt: socialAccounts.connectedAt,
    })
    .from(socialAccounts)
    .where(eq(socialAccounts.userId, userId))
    .orderBy(desc(socialAccounts.connectedAt));

  // Newest row per platform wins — the same rule the publish path resolves by.
  type Newest = (typeof rows)[number];
  const newest = new Map<string, Newest>();
  for (const row of rows) {
    if (!newest.has(row.platform)) newest.set(row.platform, row);
  }

  const health: ConnectionHealth = { permissionsMissing: [], expired: [] };
  const now = Date.now();

  await Promise.all(
    [...newest].map(async ([platform, row]) => {
      if (!row.accessTokenEnc) return;

      // A recorded expiry that has passed needs no probe: it is Meta's own
      // `expires_in` for this token, and the publish path refuses it the same
      // way (`getConnectedAccount`). Rows with a null expiry — written before
      // the column was populated — fall back to the platform's fixed lifetime,
      // and otherwise go to the probe below, which is what actually catches
      // them: their token is long-lived in name only.
      const expiry = effectiveTokenExpiry(platform, row.tokenExpiresAt, row.connectedAt);
      if (expiry && expiry.getTime() <= now) {
        health.expired.push(platform);
        return;
      }

      // Threads is the platform that hands out empty grants. Instagram and
      // Facebook reject an unauthorized app user during OAuth instead, so they
      // never reach this state.
      if (platform !== "threads") return;

      const state = await threadsConnectionState(row.accessTokenEnc);
      if (state === "no-permission") health.permissionsMissing.push(platform);
      if (state === "expired") health.expired.push(platform);
    })
  );

  health.permissionsMissing.sort();
  health.expired.sort();
  return health;
}

/** What a probe of one Threads token could establish. */
type ThreadsState = "ok" | "no-permission" | "expired" | "unknown";

/** True only when Threads itself says this token carries no permission or is dead. */
async function threadsConnectionState(encrypted: string): Promise<ThreadsState> {
  let token: string;
  try {
    token = decryptSecret(encrypted);
  } catch {
    return "unknown";
  }

  try {
    const res = await fetch(`${GRAPH_THREADS}/me?fields=id`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.ok) return "ok";

    const payload = await res.json().catch(() => null);
    if (isThreadsPermissionError(payload)) return "no-permission";
    if (isExpiredSessionError(payload)) return "expired";
    return "unknown";
  } catch {
    return "unknown";
  }
}
