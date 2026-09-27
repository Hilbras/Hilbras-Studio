/**
 * Platform registry — the single source of truth for every supported network.
 *
 * Each entry carries:
 *  - which developer-app credentials the connector needs (env var names)
 *  - official OAuth 2.0 endpoints and scopes
 *  - the platform's account model (Pages vs Profiles vs Channels…)
 *  - content capabilities and limits (consumed later by the AI adaptation layer)
 *
 * Publishing availability is tracked separately in PUBLISHING_CAPABILITIES so
 * connectable OAuth integrations are not mistaken for implemented publishers.
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
  "telegram",
] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];

export interface PlatformSpec {
  id: PlatformId;
  name: string;
  /** Account models the user may connect (drives the generic connection UI). */
  accountModel: string[];
  /**
   * How an account gets linked. Omitted means `"oauth"`; `"manual"` platforms
   * (Telegram) collect their own credentials in the Accounts modal and declare
   * no `auth` block — nothing on the OAuth code path may assume one exists.
   */
  connection?: "oauth" | "manual";
  /** Official OAuth 2.0 configuration. Absent exactly when `connection` is `"manual"`. */
  auth?: {
    clientIdEnv: string;
    clientSecretEnv: string;
    authorizeUrl: string;
    tokenUrl: string;
    scopes: string[];
    /** X uses PKCE; Reddit authenticates the token call with HTTP Basic. */
    usesPkce?: boolean;
    tokenAuth?: "body" | "basic";
    /**
     * HTTP method for the authorization-code exchange. Meta documents Facebook's
     * `/oauth/access_token` as a **GET** with the parameters in the query
     * string (manual-flow guide and the PKCE guide both), while Threads and
     * Instagram document the form-encoded POST this code defaults to.
     */
    tokenMethod?: "get" | "post";
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

export type PublishingAccountSelection = "account" | "page" | "chat" | "none";

/**
 * The standardized operations a platform may support.
 *
 * Declared here rather than in `connectors/types.ts` because this module is the
 * lowest layer of the vocabulary — the UI reads it to decide what to offer, and
 * the connector contract reads it to describe what it may implement. The
 * connector module re-exports these names, so connector code has one import
 * site either way.
 *
 * A capability is a promise about *behaviour*, not about an endpoint.
 * `get_posts` means the Runtime can read a feed in the standard shape, whether
 * the platform underneath is Graph, REST, or has no read API at all.
 */
export const CAPABILITY_NAMES = [
  "create_post",
  "publish_post",
  "get_posts",
  "get_account",
  "delete_post",
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export interface PublishingCapability {
  /**
   * What this platform can actually do, as standard capabilities.
   *
   * Replaces `status: "supported" | "connect_only"`, which was a boolean
   * wearing a type: it could answer "can it publish?" and nothing else, so
   * `get_posts` and `delete_post` had nowhere to live, and a connect-only
   * platform was indistinguishable from one whose publisher merely had a bug.
   *
   * An empty array is the honest value for a platform that completes OAuth but
   * has no publisher — connectable, and visibly incapable of acting.
   */
  capabilities: readonly CapabilityName[];
  accountSelection: PublishingAccountSelection;
  note?: string;
}

/** What every working publisher can do today. */
const PUBLISH_AND_ACCOUNT: readonly CapabilityName[] = [
  "create_post",
  "publish_post",
  "get_account",
];

/**
 * The source of truth for what the current product can actually do.
 * Connection support and action support are intentionally separate: several
 * platforms can complete OAuth today while their publisher remains unfinished.
 */
export const PUBLISHING_CAPABILITIES: Record<PlatformId, PublishingCapability> = {
  instagram: { capabilities: PUBLISH_AND_ACCOUNT, accountSelection: "account" },
  facebook: {
    capabilities: PUBLISH_AND_ACCOUNT,
    accountSelection: "page",
    note: "The current publisher selects the first Page returned by Meta.",
  },
  threads: { capabilities: PUBLISH_AND_ACCOUNT, accountSelection: "account" },
  x: { capabilities: PUBLISH_AND_ACCOUNT, accountSelection: "account" },
  linkedin: {
    capabilities: [],
    accountSelection: "none",
    note: "Publishing is not implemented yet.",
  },
  tiktok: {
    capabilities: [],
    accountSelection: "none",
    note: "Publishing is not implemented yet.",
  },
  youtube: {
    capabilities: [],
    accountSelection: "none",
    note: "Publishing is not implemented yet.",
  },
  pinterest: {
    capabilities: [],
    accountSelection: "none",
    note: "Publishing is not implemented yet.",
  },
  reddit: {
    capabilities: [],
    accountSelection: "none",
    note: "Publishing is not implemented yet.",
  },
  telegram: { capabilities: PUBLISH_AND_ACCOUNT, accountSelection: "chat" },
};

export function isPlatformId(value: string): value is PlatformId {
  return (PLATFORM_IDS as readonly string[]).includes(value);
}

export function getPublishingCapability(id: string): PublishingCapability | null {
  return isPlatformId(id) ? PUBLISHING_CAPABILITIES[id] : null;
}

/** What a platform can do in general, or nothing for an id we do not know. */
export function capabilitiesForPlatform(id: string): readonly CapabilityName[] {
  return getPublishingCapability(id)?.capabilities ?? [];
}

/**
 * Whether a platform can perform a capability.
 *
 * The check every caller should use instead of testing for a publish status: a
 * platform with no publisher answers `false` here, and so does one this build
 * has never heard of.
 */
export function platformSupports(
  id: string,
  capability: CapabilityName,
): boolean {
  return capabilitiesForPlatform(id).includes(capability);
}

export function isPublishablePlatform(id: string): id is PlatformId {
  return platformSupports(id, "publish_post");
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
        // The inbox reads conversations; without this scope its IG tab is empty.
        "instagram_business_manage_messages",
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
      authorizeUrl: "https://www.facebook.com/v26.0/dialog/oauth",
      tokenUrl: "https://graph.facebook.com/v26.0/oauth/access_token",
      // Meta's manual-flow guide specifies GET with query parameters for this
      // endpoint — not the form-encoded POST Threads/Instagram use.
      tokenMethod: "get",
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

  telegram: {
    id: "telegram",
    name: "Telegram",
    accountModel: ["Channel", "Group", "Direct message"],
    // No OAuth: the user pastes a bot token from @BotFather plus the chat it
    // should post to. The Accounts modal collects both, and the token is stored
    // per-user in `social_accounts.accessToken_enc` (chat id → `platform_account_id`).
    connection: "manual",
    content: {
      mediaTypes: ["text", "image", "video", "link"],
      maxTextLength: 4096,
      rules: [
        "4096 characters per message; longer posts are split into a thread",
        "Photo and video captions are limited to 1024 characters",
        "Sent as plain text — markdown syntax shows literally",
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
  const auth = PLATFORM_REGISTRY[id].auth;
  // Manual platforms (Telegram) have no developer-app pair to read from env.
  if (!auth) return false;
  return Boolean(process.env[auth.clientIdEnv] && process.env[auth.clientSecretEnv]);
}