import "server-only";

import { fetchWithTimeout } from "./http";
import type { PlatformId } from "./platforms";

/**
 * Profile lookup for the OAuth platforms whose code exchange does not identify
 * the account (remediation Task 9).
 *
 * Meta platforms resolve the account through their own `/me` branches in the
 * callback route — they need endpoint-specific error handling (Threads
 * permission denials, Instagram account types). The six platforms here share
 * one shape: GET a documented endpoint with the fresh access token, read the
 * platform-stable account id and a display handle.
 *
 * A profile that cannot be resolved fails the connect. Storing `unknown` as a
 * platform account id used to be the fallback, which collided every identity
 * on a platform onto one row — an unusable account pretending to be connected.
 */

export interface PlatformProfile {
  /** Platform-stable account id — what publish endpoints and keys use. */
  id: string;
  /** Display handle, when the platform exposes one. */
  handle?: string | null;
}

interface ProfileSpec {
  url: string;
  headers: (accessToken: string) => Record<string, string>;
  /** Read the documented response shape; null means "not resolvable". */
  parse: (body: Record<string, unknown>) => PlatformProfile | null;
}

/** Reddit rejects API calls without a User-Agent identifying the app. */
const REDDIT_USER_AGENT = "HilbrasStudio/1.0";

const bearer = (accessToken: string): Record<string, string> => ({
  Authorization: `Bearer ${accessToken}`,
});

const PROFILE_ENDPOINTS: Partial<Record<PlatformId, ProfileSpec>> = {
  // GET /2/users/me → { data: { id, name, username } }
  x: {
    url: "https://api.x.com/2/users/me",
    headers: bearer,
    parse: (body) => {
      const data = body.data as { id?: unknown; username?: unknown } | undefined;
      if (typeof data?.id !== "string") return null;
      return {
        id: data.id,
        handle: typeof data.username === "string" ? data.username : null,
      };
    },
  },

  // GET /api/v1/me → { id: "t2_…", name: "<username>", … }
  reddit: {
    url: "https://oauth.reddit.com/api/v1/me",
    headers: (token) => ({ ...bearer(token), "User-Agent": REDDIT_USER_AGENT }),
    parse: (body) => {
      if (typeof body.id !== "string") return null;
      return {
        id: body.id,
        handle: typeof body.name === "string" ? body.name : null,
      };
    },
  },

  // OIDC userinfo → { sub, name, … }
  linkedin: {
    url: "https://api.linkedin.com/v2/userinfo",
    headers: bearer,
    parse: (body) => {
      if (typeof body.sub !== "string") return null;
      return {
        id: body.sub,
        handle: typeof body.name === "string" ? body.name : null,
      };
    },
  },

  // GET /v2/user/info/?fields=open_id,display_name → { data: { user: { … } } }
  tiktok: {
    url: "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name",
    headers: bearer,
    parse: (body) => {
      const user = (body.data as { user?: { open_id?: unknown; display_name?: unknown } } | undefined)
        ?.user;
      if (typeof user?.open_id !== "string") return null;
      return {
        id: user.open_id,
        handle: typeof user.display_name === "string" ? user.display_name : null,
      };
    },
  },

  // GET channels?part=snippet&mine=true → { items: [{ id, snippet: { title } }] }
  youtube: {
    url: "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
    headers: bearer,
    parse: (body) => {
      const item = (body.items as Array<{ id?: unknown; snippet?: { title?: unknown } }> | undefined)?.[0];
      if (typeof item?.id !== "string") return null;
      return {
        id: item.id,
        handle: typeof item.snippet?.title === "string" ? item.snippet.title : null,
      };
    },
  },

  // GET /v5/user_account → { username, … } — the username is Pinterest's
  // stable, unique account identifier; the API exposes no separate id.
  pinterest: {
    url: "https://api.pinterest.com/v5/user_account",
    headers: bearer,
    parse: (body) => {
      if (typeof body.username !== "string") return null;
      return { id: body.username, handle: body.username };
    },
  },
};

/** Whether the callback route must resolve a profile for this platform. */
export function hasProfileLookup(platform: string): platform is PlatformId {
  return Boolean(PROFILE_ENDPOINTS[platform as PlatformId]);
}

/**
 * Resolve the connected account's identity with the freshly minted token.
 *
 * Returns null on any failure — bad status, undecodable body, missing id —
 * and the caller treats that as a failed connect rather than storing a
 * placeholder account.
 */
export async function fetchPlatformProfile(
  platform: string,
  accessToken: string
): Promise<PlatformProfile | null> {
  const spec = PROFILE_ENDPOINTS[platform as PlatformId];
  if (!spec) return null;

  try {
    const res = await fetchWithTimeout(spec.url, { headers: spec.headers(accessToken) });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return null;
    return spec.parse(body);
  } catch {
    return null;
  }
}
