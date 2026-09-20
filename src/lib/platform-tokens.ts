/**
 * Long-lived token upgrade for Meta platforms.
 *
 * The OAuth code exchange on Instagram (Instagram Login) and Threads returns a
 * short-lived user token that expires after one hour. A connection is only
 * durable once that token is exchanged for a long-lived one (60 days) —
 * otherwise every connected account stops working within the hour.
 *
 * Docs:
 *   Instagram  GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token
 *   Threads    GET https://graph.threads.net/access_token?grant_type=th_exchange_token
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
  Record<string, { url: string; grantType: string }>
> = {
  instagram: {
    url: "https://graph.instagram.com/access_token",
    grantType: "ig_exchange_token",
  },
  threads: {
    url: "https://graph.threads.net/access_token",
    grantType: "th_exchange_token",
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
 * Returns null when the platform has no long-lived exchange or the upgrade
 * fails — callers keep the short-lived token, so the connection still works
 * (just for a shorter window) instead of failing outright.
 */
export async function exchangeForLongLivedToken(
  platform: string,
  shortLivedToken: string,
  clientSecret: string
): Promise<LongLivedToken | null> {
  const endpoint = EXCHANGE_ENDPOINTS[platform];
  if (!endpoint) return null;

  const url = new URL(endpoint.url);
  url.searchParams.set("grant_type", endpoint.grantType);
  url.searchParams.set("client_secret", clientSecret);
  url.searchParams.set("access_token", shortLivedToken);

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
