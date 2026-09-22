/**
 * Long-lived token upgrade for Meta platforms.
 *
 * The OAuth code exchange returns a short-lived user token that expires after
 * one hour. A connection is only durable once that token is exchanged for a
 * long-lived one (60 days) — otherwise every connected account stops working
 * within the hour. Facebook uses the same endpoint as its code exchange, with
 * `fb_exchange_token` in place of `authorization_code`, and additionally wants
 * the `client_id` alongside the secret.
 *
 * Docs:
 *   Instagram  GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token
 *   Threads    GET https://graph.threads.net/access_token?grant_type=th_exchange_token
 *   Facebook   GET https://graph.facebook.com/v26.0/oauth/access_token?grant_type=fb_exchange_token
 */

export interface LongLivedToken {
  accessToken: string;
  /** Seconds until expiry, as reported by the platform. */
  expiresIn: number | null;
}

interface MetaTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: { message?: string };
}

const EXCHANGE_ENDPOINTS: Partial<
  Record<
    string,
    {
      url: string;
      grantType: string;
      /** Query parameter that carries the token — `access_token` everywhere except Facebook. */
      tokenParam?: string;
      usesClientId?: boolean;
    }
  >
> = {
  instagram: {
    url: "https://graph.instagram.com/access_token",
    grantType: "ig_exchange_token",
  },
  threads: {
    url: "https://graph.threads.net/access_token",
    grantType: "th_exchange_token",
  },
  facebook: {
    url: "https://graph.facebook.com/v26.0/oauth/access_token",
    grantType: "fb_exchange_token",
    // Meta answers `access_token=` with "fb_exchange_token parameter not
    // specified" — the exchanged token goes under its own parameter name.
    tokenParam: "fb_exchange_token",
    usesClientId: true,
  },
};

/** Whether the platform issues a short-lived token that should be upgraded. */
export function supportsLongLivedToken(platform: string): boolean {
  return Boolean(EXCHANGE_ENDPOINTS[platform]);
}

/**
 * Refresh endpoints for long-lived tokens.
 *
 * Unlike the short→long exchange, refreshing does **not** take the app secret —
 * only `grant_type` and the existing long-lived `access_token`. Per the docs the
 * token must be at least 24 hours old and not yet expired, and each refresh
 * grants another 60 days. A token left unrefreshed for 60 days is dead.
 *
 * Docs: Instagram GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token
 *       Threads   GET https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token
 */
const REFRESH_ENDPOINTS: Partial<Record<string, { url: string; grantType: string }>> = {
  instagram: {
    url: "https://graph.instagram.com/refresh_access_token",
    grantType: "ig_refresh_token",
  },
  threads: {
    url: "https://graph.threads.net/refresh_access_token",
    grantType: "th_refresh_token",
  },
};

/** Whether a long-lived token for this platform can be refreshed in place. */
export function supportsTokenRefresh(platform: string): boolean {
  return Boolean(REFRESH_ENDPOINTS[platform]);
}

/** Platform ids `refreshLongLivedToken` can act on — what the maintainer scans. */
export function refreshablePlatforms(): string[] {
  return Object.keys(REFRESH_ENDPOINTS);
}

/**
 * How close to expiry a token must be before it is worth refreshing.
 *
 * Meta allows a refresh any time the long-lived token is at least 24 hours old
 * **and still valid**, so there is nothing to gain from waiting until the last
 * week: a 30-day window turns a missed publish or one failed refresh attempt
 * into a retry on the next run, instead of a connection that dies in silence
 * because nothing happened to publish during its final 7 days.
 *
 * Shared by the publish path (refresh just in time) and the cron maintainer
 * (refresh ahead of time).
 */
export const TOKEN_REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Assumed lifetime when the platform omits `expires_in` (60 days). */
export const DEFAULT_TOKEN_LIFETIME_SECONDS = 60 * 24 * 60 * 60;

/**
 * Effective expiry of a stored token: the platform's own `expires_in` when it
 * recorded one, otherwise — for platforms with a fixed 60-day lifetime — the
 * connect time plus that lifetime.
 *
 * The fallback matters because rows written before `tokenExpiresAt` was stored
 * carry a `null`, which used to disable the refresh logic outright: the token
 * aged out 60 days after connect and nothing ever noticed. For platforms whose
 * lifetime is not known to be fixed, `null` stays `null` ("unknown"), never a
 * guess.
 */
export function effectiveTokenExpiry(
  platform: string,
  tokenExpiresAt: Date | null,
  connectedAt: Date
): Date | null {
  if (tokenExpiresAt) return tokenExpiresAt;
  if (supportsTokenRefresh(platform)) {
    return new Date(connectedAt.getTime() + DEFAULT_TOKEN_LIFETIME_SECONDS * 1000);
  }
  return null;
}

/** Shape of Meta's error envelope — only the fields the checks below read. */
interface MetaErrorPayload {
  error?: {
    message?: unknown;
    code?: unknown;
    error_subcode?: unknown;
  };
}

/**
 * True for Meta's "this session is over" answer.
 *
 * An expired token is reported as `code: 190` — the same code used for a
 * malformed token — with `error_subcode: 463` on the endpoints that send a
 * subcode, and always the wording `Session has expired on <date>` in the
 * message. Both halves are checked because the subcode is missing on some
 * endpoints while the wording has proven stable across them.
 *
 * This is the error a connection hits when nothing refreshed it in time, and it
 * is the one case the platform itself cannot help with: Meta will only refresh
 * a token that is still valid, so the answer is always "reconnect".
 */
export function isExpiredSessionError(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;

  const { message, code, error_subcode } = (payload as MetaErrorPayload).error ?? {};

  if (code === 190 && error_subcode === 463) return true;

  return typeof message === "string" && message.includes("Session has expired");
}

/**
 * What the user has to do about an expired session — one sentence, shared by
 * the publish result and the Accounts notice so both say the same thing.
 */
export const TOKEN_EXPIRED_FIX =
  "The OAuth session for this platform has expired. Meta only refreshes a token while it is " +
  "still valid, so an expired one cannot be renewed — reconnect to issue a new session.";

/** Short label for the Accounts card (see `THREADS_PERMISSION_BADGE`). */
export const TOKEN_EXPIRED_BADGE = "Session expired — reconnect";

/** The publish-time variant: names the platform so a multi-platform post reads clearly. */
export function tokenExpiredMessage(platform: string): string {
  const name = platform.charAt(0).toUpperCase() + platform.slice(1);
  return `${name}: the session expired and must be renewed — reconnect from Accounts → ${name} → Config → Reconnect via OAuth.`;
}

/** Shared GET-and-parse for the token endpoints (exchange and refresh). */
async function fetchToken(
  platform: string,
  url: string
): Promise<LongLivedToken | null> {
  try {
    const res = await fetch(url, { method: "GET" });
    const body = (await res.json().catch(() => ({}))) as MetaTokenResponse;

    if (!res.ok || !body.access_token) {
      console.warn(
        `[${platform}] token request failed (${res.status}) ${
          body.error?.message ?? ""
        }`.trim()
      );
      return null;
    }

    return { accessToken: body.access_token, expiresIn: body.expires_in ?? null };
  } catch (e) {
    console.warn(
      `[${platform}] token request errored`,
      e instanceof Error ? e.message : e
    );
    return null;
  }
}

/**
 * Exchange a short-lived token for a long-lived one.
 *
 * `clientId` is only passed for the endpoint that requires it (Facebook's
 * `fb_exchange_token` wants the app id next to the secret; Instagram's and
 * Threads' dedicated exchange endpoints reject extra parameters less
 * predictably, so they get exactly what they document).
 *
 * Returns null when the platform has no long-lived exchange or the upgrade
 * fails — callers keep the short-lived token, so the connection still works
 * (just for a shorter window) instead of failing outright.
 */
export async function exchangeForLongLivedToken(
  platform: string,
  shortLivedToken: string,
  clientSecret: string,
  clientId?: string
): Promise<LongLivedToken | null> {
  const endpoint = EXCHANGE_ENDPOINTS[platform];
  if (!endpoint) return null;

  const url = new URL(endpoint.url);
  url.searchParams.set("grant_type", endpoint.grantType);
  url.searchParams.set("client_secret", clientSecret);
  url.searchParams.set(endpoint.tokenParam ?? "access_token", shortLivedToken);
  if (endpoint.usesClientId && clientId) {
    url.searchParams.set("client_id", clientId);
  }

  return fetchToken(platform, url.toString());
}

/**
 * Refresh a long-lived token, extending its life by another 60 days.
 *
 * Called before a token is about to expire (see the publish path). Returns null
 * if the platform cannot refresh or the refresh fails, in which case the caller
 * keeps using the existing token until it really does expire.
 */
export async function refreshLongLivedToken(
  platform: string,
  longLivedToken: string
): Promise<LongLivedToken | null> {
  const endpoint = REFRESH_ENDPOINTS[platform];
  if (!endpoint) return null;

  const url = new URL(endpoint.url);
  url.searchParams.set("grant_type", endpoint.grantType);
  url.searchParams.set("access_token", longLivedToken);

  return fetchToken(platform, url.toString());
}
