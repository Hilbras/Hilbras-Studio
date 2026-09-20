/**
 * Platform registry — the single source of truth for every supported network.
 *
 * Each entry carries:
 *  - which developer-app credentials the connector needs (env var names)
 *  - official OAuth 2.0 endpoints and scopes
 *  - the platform's account model (Pages vs Profiles vs Channels…)
 *  - content capabilities and limits (consumed later by the AI adaptation layer)
 *
 * This file is pure data: safe to import from client and server code.
 * Credentials themselves are only ever read server-side via the env names.
 */

export const PLATFORM_IDS = [
  "instagram",
  "facebook",
  "threads",
  "x",
  "linkedin",
  "tiktok",
  "youtube",
  "pinterest",
  "reddit",
] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];

export interface PlatformSpec {
  id: PlatformId;
  name: string;
  /** Account models the user may connect (drives the generic connection UI). */
  accountModel: string[];
  /** Official OAuth 2.0 configuration. */
  auth: {
    clientIdEnv: string;
    clientSecretEnv: string;
    authorizeUrl: string;
    tokenUrl: string;
    scopes: string[];
    /** X uses PKCE; Reddit authenticates the token call with HTTP Basic. */
    usesPkce?: boolean;
    tokenAuth?: "body" | "basic";
    /** Extra headers some providers require. */
    extraHeaders?: Record<string, string>;
    /**
     * Shown above the credential fields in Settings → Accounts for providers
     * where the wrong pair is easy to paste (Meta issues more than one app ID).
     */
    credentialHint?: string;
  };
  /** Content capabilities — the facts the AI adapts copy against. */
  content: {
    mediaTypes: ("image" | "video" | "text" | "link")[];
    maxTextLength: number | null;
    /** Hard platform rules the AI must respect. */
    rules: string[];
  };
}

export const PLATFORM_REGISTRY: Record<PlatformId, PlatformSpec> = {
  instagram: {
    id: "instagram",
    name: "Instagram",
    accountModel: ["Professional account (Business/Creator)"],
    auth: {
      clientIdEnv: "INSTAGRAM_CLIENT_ID",
      clientSecretEnv: "INSTAGRAM_CLIENT_SECRET",
      authorizeUrl: "https://www.instagram.com/oauth/authorize",
      tokenUrl: "https://api.instagram.com/oauth/access_token",
      scopes: [
        "instagram_business_basic",
        "instagram_business_content_publish",
        "instagram_business_manage_comments",
      ],
    },
    content: {
      mediaTypes: ["image", "video"],
      maxTextLength: 2200,
      rules: [
        "Links in captions are not clickable — put URLs in bio or stickers",
        "Supports feed posts, carousels, Reels and Stories",
        "Hashtags are expected and surface content in Explore",
      ],
    },
  },

  facebook: {
    id: "facebook",
    name: "Facebook",
    accountModel: ["Profile", "Page"],
    auth: {
      clientIdEnv: "FACEBOOK_CLIENT_ID",
      clientSecretEnv: "FACEBOOK_CLIENT_SECRET",
      authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
      tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
      scopes: [
        "pages_show_list",
        "pages_read_engagement",
        "pages_manage_posts",
        "pages_manage_metadata",
      ],
    },
    content: {
      mediaTypes: ["text", "image", "video"],
      maxTextLength: 63206,
      rules: [
        "Publishing targets a Page, not the personal Profile",
        "Links are clickable and generate preview cards",
        "Native video outperforms external links in reach",
      ],
    },
  },

  threads: {
    id: "threads",
    name: "Threads",
    accountModel: ["Profile"],
    auth: {
      clientIdEnv: "THREADS_CLIENT_ID",
      clientSecretEnv: "THREADS_CLIENT_SECRET",
      // Threads authorizes through Meta's OAuth engine, but with its own app ID:
      // one Meta app issues two pairs, and graph.threads.net only accepts the
      // Threads one.
      authorizeUrl: "https://threads.net/oauth/authorize",
      tokenUrl: "https://graph.threads.net/oauth/access_token",
      scopes: ["threads_basic", "threads_content_publish"],
      credentialHint:
        "A Meta app issues two credential pairs. Use the Threads app ID and secret from the app's Threads use case (Settings → Threads) — the Facebook/Instagram pair is rejected by the Threads API.",
    },
    content: {
      mediaTypes: ["text", "image", "video"],
      maxTextLength: 500,
      rules: [
        "Conversational tone outperforms polished marketing copy",
        "No native hashtag culture — use sparingly",
        "Replies and chains work like X threads",
      ],
    },
  },

  x: {
    id: "x",
    name: "X",
    accountModel: ["Account"],
    auth: {
      clientIdEnv: "X_CLIENT_ID",
      clientSecretEnv: "X_CLIENT_SECRET",
      authorizeUrl: "https://x.com/i/oauth2/authorize",
      tokenUrl: "https://api.x.com/2/oauth2/token",
      scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
      usesPkce: true,
      tokenAuth: "basic",
    },
    content: {
      mediaTypes: ["text", "image", "video"],
      maxTextLength: 280,
      rules: [
        "280 characters per post — long content must become a thread",
        "1–4 images or one video per post",
        "Front-load the hook: only first ~2 lines show in feed",
      ],
    },
  },

  linkedin: {
    id: "linkedin",
    name: "LinkedIn",
    accountModel: ["Member profile", "Organization page"],
    auth: {
      clientIdEnv: "LINKEDIN_CLIENT_ID",
      clientSecretEnv: "LINKEDIN_CLIENT_SECRET",
      authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
      tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
      scopes: ["openid", "profile", "w_member_social"],
    },
    content: {
      mediaTypes: ["text", "image", "video"],
      maxTextLength: 3000,
      rules: [
        "Professional tone; insight and story beats hard sell",
        "First ~210 characters show before 'see more'",
        "Posting as an Organization requires the organization URN",
      ],
    },
  },

  tiktok: {
    id: "tiktok",
    name: "TikTok",
    accountModel: ["Account"],
    auth: {
      clientIdEnv: "TIKTOK_CLIENT_KEY",
      clientSecretEnv: "TIKTOK_CLIENT_SECRET",
      authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
      tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
      scopes: ["user.info.basic", "video.publish", "video.upload"],
    },
    content: {
      mediaTypes: ["video"],
      maxTextLength: 2200,
      rules: [
        "Video-only platform — text posts are not supported",
        "Caption + hashtags drive the For You distribution",
        "Native, lo-fi style outperforms produced ads",
      ],
    },
  },

  youtube: {
    id: "youtube",
    name: "YouTube",
    accountModel: ["Channel"],
    auth: {
      clientIdEnv: "GOOGLE_CLIENT_ID",
      clientSecretEnv: "GOOGLE_CLIENT_SECRET",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/youtube.upload",
        "https://www.googleapis.com/auth/youtube.readonly",
      ],
    },
    content: {
      mediaTypes: ["video"],
      maxTextLength: 5000,
      rules: [
        "Title ≤100 chars; description ≤5000 chars",
        "Thumbnail and title decide the click — write them as a pair",
        "Uploads via official API are set to private until reviewed by the channel owner by default",
      ],
    },
  },

  pinterest: {
    id: "pinterest",
    name: "Pinterest",
    accountModel: ["Account", "Board"],
    auth: {
      clientIdEnv: "PINTEREST_CLIENT_ID",
      clientSecretEnv: "PINTEREST_CLIENT_SECRET",
      authorizeUrl: "https://www.pinterest.com/oauth/",
      tokenUrl: "https://api.pinterest.com/v5/oauth/token",
      scopes: ["boards:read", "boards:write", "pins:read", "pins:write"],
    },
    content: {
      mediaTypes: ["image", "video"],
      maxTextLength: 500,
      rules: [
        "Every pin needs an image plus a destination link and a board",
        "Title ≤100 chars, description ≤500 chars",
        "Keyword-rich descriptions act as long-tail search",
      ],
    },
  },

  reddit: {
    id: "reddit",
    name: "Reddit",
    accountModel: ["User", "Subreddit (as moderator)"],
    auth: {
      clientIdEnv: "REDDIT_CLIENT_ID",
      clientSecretEnv: "REDDIT_CLIENT_SECRET",
      authorizeUrl: "https://www.reddit.com/api/v1/authorize",
      tokenUrl: "https://www.reddit.com/api/v1/access_token",
      scopes: ["identity", "submit", "read"],
      tokenAuth: "basic",
      extraHeaders: { "User-Agent": "HilbrasStudio/1.0" },
    },
    content: {
      mediaTypes: ["text", "image", "link"],
      maxTextLength: 40000,
      rules: [
        "Title ≤300 chars and matters more than body",
        "Each subreddit has its own rules — self-promotion is heavily restricted",
        "Value-first participation; blatant marketing gets removed",
      ],
    },
  },
};

/** Registry order is the canonical display order across the UI. */
export function allPlatforms(): PlatformSpec[] {
  return PLATFORM_IDS.map((id) => PLATFORM_REGISTRY[id]);
}

export function getPlatform(id: PlatformId): PlatformSpec {
  return PLATFORM_REGISTRY[id];
}

/**
 * Whether the developer-app credentials for a platform are present in the
 * environment. Server-side only — never call from client components.
 */
export function platformCredentialsConfigured(id: PlatformId): boolean {
  const { clientIdEnv, clientSecretEnv } = PLATFORM_REGISTRY[id].auth;
  return Boolean(process.env[clientIdEnv] && process.env[clientSecretEnv]);
}