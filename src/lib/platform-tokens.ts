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

  try {
    const res = await fetch(url.toString(), { method: "GET" });
    const body = (await res.json().catch(() => ({}))) as MetaTokenResponse;

    if (!res.ok || !body.access_token) {
      console.warn(
        `[${platform}] long-lived token exchange failed (${res.status}) ${
          body.error?.message ?? ""
        }`.trim()
      );
      return null;
    }

    return { accessToken: body.access_token, expiresIn: body.expires_in ?? null };
  } catch (e) {
    console.warn(
      `[${platform}] long-lived token exchange errored`,
      e instanceof Error ? e.message : e
    );
    return null;
  }
}
