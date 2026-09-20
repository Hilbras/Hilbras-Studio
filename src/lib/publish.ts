"use server";

import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db";
import { socialAccounts } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { PLATFORM_REGISTRY } from "@/lib/platforms";
import {
  refreshLongLivedToken,
  supportsTokenRefresh,
} from "@/lib/platform-tokens";
import { getSessionUser } from "@/lib/session";

interface PublishResult {
  platform: string;
  success: boolean;
  postId?: string;
  error?: string;
  url?: string;
}

/**
 * Graph API hosts.
 *
 * Tokens minted by the Instagram API with Instagram Login are only accepted by
 * `graph.instagram.com`; Facebook Page tokens only by `graph.facebook.com`.
 * Posting an Instagram Login token to the Facebook host fails every time.
 */
const GRAPH_FACEBOOK = "https://graph.facebook.com/v21.0";
const GRAPH_INSTAGRAM = "https://graph.instagram.com/v21.0";
const GRAPH_THREADS = "https://graph.threads.net/v1.0";

interface GraphError {
  error?: { message?: string };
}

interface ConnectedAccount {
  accessToken: string;
  platformAccountId: string;
}

/** Errors surface as `unknown` — read a message out of them without `any`. */
function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** Sleep helper for the container processing polls. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Refresh a long-lived token this close to expiry. Threads/Instagram tokens live
 * 60 days and are only refreshable while still valid, so refreshing a week ahead
 * leaves plenty of room for a retry if the first attempt fails.
 */
const TOKEN_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Fallback lifetime when the platform omits `expires_in` (60 days). */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 60 * 24 * 60 * 60;

/**
 * Load the connection for a platform. Newest row wins, so a connection made
 * before reconnects replaced rows instead of appending them can't shadow it.
 *
 * If the platform's long-lived token is within `TOKEN_REFRESH_WINDOW_MS` of
 * expiring, it is refreshed here and written back: otherwise the connection
 * silently dies ~60 days after connect, because nothing else acts on
 * `tokenExpiresAt`.
 */
async function getConnectedAccount(
  userId: string,
  platform: string
): Promise<ConnectedAccount | null> {
  const [account] = await db
    .select({
      id: socialAccounts.id,
      accessTokenEnc: socialAccounts.accessTokenEnc,
      platformAccountId: socialAccounts.platformAccountId,
      tokenExpiresAt: socialAccounts.tokenExpiresAt,
    })
    .from(socialAccounts)
    .where(
      and(
        eq(socialAccounts.userId, userId),
        eq(socialAccounts.platform, platform)
      )
    )
    .orderBy(desc(socialAccounts.connectedAt))
    .limit(1);

  if (!account?.accessTokenEnc) return null;

  let accessToken: string;
  try {
    accessToken = decryptSecret(account.accessTokenEnc);
  } catch {
    return null;
  }

  if (account.tokenExpiresAt && supportsTokenRefresh(platform)) {
    const msLeft = account.tokenExpiresAt.getTime() - Date.now();
    if (msLeft > 0 && msLeft < TOKEN_REFRESH_WINDOW_MS) {
      const refreshed = await refreshLongLivedToken(platform, accessToken);
      if (refreshed) {
        accessToken = refreshed.accessToken;
        const expiresAt = new Date(
          Date.now() +
            (refreshed.expiresIn ?? DEFAULT_TOKEN_LIFETIME_SECONDS) * 1000
        );
        await db
          .update(socialAccounts)
          .set({
            accessTokenEnc: encryptSecret(accessToken),
            tokenExpiresAt: expiresAt,
          })
          .where(eq(socialAccounts.id, account.id));
      }
    }
  }

  return { accessToken, platformAccountId: account.platformAccountId };
}

/** Get a decrypted access token for a specific connected platform. */
async function getAccessToken(userId: string, platform: string): Promise<string | null> {
  return (await getConnectedAccount(userId, platform))?.accessToken ?? null;
}

/** Container states reported by `GET /<container>?fields=status_code`. */
type ContainerStatus = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

/**
 * Wait for a media container to finish processing before publishing it.
 *
 * Image containers are usually FINISHED immediately, so this mirrors Meta's
 * documented polling loop with a short budget: "unknown" means the status could
 * not be read in time and the caller should attempt the publish anyway.
 */
async function containerReady(
  containerId: string,
  token: string,
  attempts = 4
): Promise<"ready" | "failed" | "unknown"> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(
        `${GRAPH_INSTAGRAM}/${containerId}?fields=status_code&access_token=${encodeURIComponent(token)}`
      );
      if (res.ok) {
        const { status_code } = (await res.json()) as { status_code?: ContainerStatus };
        if (status_code === "FINISHED" || status_code === "PUBLISHED") return "ready";
        if (status_code === "ERROR" || status_code === "EXPIRED") return "failed";
      }
    } catch {
      // Fall through to the delay: publishing may still succeed.
    }
    await delay(1500);
  }
  return "unknown";
}

/**
 * `media_publish` returns the media id, which is not the URL a user can open —
 * the public permalink takes one extra read call. Failing it only costs the
 * link, not the post.
 */
async function instagramPermalink(
  mediaId: string,
  token: string
): Promise<string | undefined> {
  try {
    const res = await fetch(
      `${GRAPH_INSTAGRAM}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token)}`
    );
    if (!res.ok) return undefined;
    const { permalink } = (await res.json()) as { permalink?: string };
    return permalink;
  } catch {
    return undefined;
  }
}

/**
 * Publish to Instagram via the Instagram Platform API.
 * Requires: create container → wait for processing → publish container.
 *
 * Host must be `graph.instagram.com` because credentials come from the
 * Instagram API with Instagram Login product (see Meta "Content Publishing").
 */
async function publishToInstagram(userId: string, text: string, imageUrl?: string): Promise<PublishResult> {
  const account = await getConnectedAccount(userId, "instagram");
  if (!account) {
    return { platform: "instagram", success: false, error: "Instagram not connected" };
  }

  if (!imageUrl) {
    // Instagram has no text-only posts; every publish needs media.
    return {
      platform: "instagram",
      success: false,
      error: "Instagram requires an image or video. Add a media URL to publish.",
    };
  }

  const token = account.accessToken;
  const igUserId = account.platformAccountId;

  try {
    // Step 1: create the media container.
    const containerRes = await fetch(`${GRAPH_INSTAGRAM}/${igUserId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        media_type: "IMAGE",
        image_url: imageUrl,
        caption: text,
        access_token: token,
      }),
    });

    if (!containerRes.ok) {
      const err = (await containerRes.json().catch(() => ({}))) as GraphError;
      return {
        platform: "instagram",
        success: false,
        error: err.error?.message || `Container creation failed: ${containerRes.status}`,
      };
    }

    const { id: containerId } = (await containerRes.json()) as { id?: string };
    if (!containerId) {
      return { platform: "instagram", success: false, error: "Instagram returned no media container" };
    }

    // Step 2: make sure the container finished processing.
    if ((await containerReady(containerId, token)) === "failed") {
      return {
        platform: "instagram",
        success: false,
        error: "Instagram could not process the media — check that the image URL is public",
      };
    }

    // Step 3: publish the container.
    const publishRes = await fetch(`${GRAPH_INSTAGRAM}/${igUserId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        creation_id: containerId,
        access_token: token,
      }),
    });

    if (!publishRes.ok) {
      const err = (await publishRes.json().catch(() => ({}))) as GraphError;
      return {
        platform: "instagram",
        success: false,
        error: err.error?.message || `Publish failed: ${publishRes.status}`,
      };
    }

    const { id: mediaId } = (await publishRes.json()) as { id?: string };
    return {
      platform: "instagram",
      success: true,
      postId: mediaId,
      url: mediaId ? await instagramPermalink(mediaId, token) : undefined,
    };
  } catch (e) {
    return { platform: "instagram", success: false, error: errorMessage(e, "Instagram publish failed") };
  }
}

/**
 * Publish to Facebook Pages via Graph API.
 */
async function publishToFacebook(userId: string, text: string, imageUrl?: string): Promise<PublishResult> {
  const token = await getAccessToken(userId, "facebook");
  if (!token) return { platform: "facebook", success: false, error: "Facebook not connected" };

  try {
    // Get user's pages
    const pagesRes = await fetch(
      `${GRAPH_FACEBOOK}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(token)}`
    );
    if (!pagesRes.ok) {
      return { platform: "facebook", success: false, error: `Failed to get pages: ${pagesRes.status}` };
    }
    const pages = await pagesRes.json() as { data: Array<{ id: string; name: string; access_token: string }> };

    if (!pages.data?.length) {
      return { platform: "facebook", success: false, error: "No Facebook Pages found" };
    }

    // Publish to the first page
    const page = pages.data[0];
    const body: Record<string, string> = {
      message: text,
      access_token: page.access_token,
    };

    if (imageUrl) {
      body.url = imageUrl;
    }

    const publishRes = await fetch(
      `${GRAPH_FACEBOOK}/${page.id}/feed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!publishRes.ok) {
      const err = await publishRes.json() as { error?: { message?: string } };
      return { platform: "facebook", success: false, error: err.error?.message || `Publish failed: ${publishRes.status}` };
    }

    const published = await publishRes.json() as { id: string };
    return {
      platform: "facebook",
      success: true,
      postId: published.id,
      url: `https://www.facebook.com/posts/${published.id}`,
    };
  } catch (e) {
    return { platform: "facebook", success: false, error: errorMessage(e, "Facebook publish failed") };
  }
}

/**
 * Publish to X (Twitter) via API v2.
 * Note: X posting requires elevated access (Basic or Pro tier).
 */
async function publishToX(userId: string, text: string): Promise<PublishResult> {
  const token = await getAccessToken(userId, "x");
  if (!token) return { platform: "x", success: false, error: "X not connected" };

  try {
    const res = await fetch("https://api.x.com/2/tweets", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const err = await res.json() as { errors?: Array<{ message: string }> };
      return { platform: "x", success: false, error: err.errors?.[0]?.message || `X publish failed: ${res.status}` };
    }

    const published = await res.json() as { data?: { id: string } };
    return {
      platform: "x",
      success: true,
      postId: published.data?.id,
      url: published.data?.id ? `https://x.com/i/web/status/${published.data.id}` : undefined,
    };
  } catch (e) {
    return { platform: "x", success: false, error: errorMessage(e, "X publish failed") };
  }
}

/** `media_type` values the Threads publishing API accepts for our post kinds. */
type ThreadsMediaType = "TEXT" | "IMAGE" | "VIDEO";

const VIDEO_URL_PATTERN = /\.(mp4|mov|m4v|webm)(\?.*)?$/i;

/**
 * Pick the Threads `media_type` for a post.
 *
 * The composer supplies a single media URL, so the kind is read off the URL
 * (docs: IMAGE posts take `image_url`, VIDEO posts take `video_url`). Anything
 * that is not recognisably a video is treated as an image, which is what the
 * composer's URL field has always meant.
 */
function threadsMediaType(mediaUrl?: string): ThreadsMediaType {
  if (!mediaUrl) return "TEXT";
  return VIDEO_URL_PATTERN.test(mediaUrl) ? "VIDEO" : "IMAGE";
}

/**
 * How long to wait for a container to finish processing, per media type.
 *
 * Meta's guidance for the Threads API is that an app "should wait an average of
 * 30 seconds" after creating a container before calling `threads_publish`, and
 * video processing takes longer than images. Text containers are FINISHED as
 * soon as they are created, so they only need a token check.
 *
 * Note: this blocks the request for up to 60s on a video post — well within a
 * Node server's budget, but a serverless plan with a lower function timeout
 * should lower `VIDEO` accordingly.
 */
const THREADS_CONTAINER_BUDGET_MS: Record<ThreadsMediaType, number> = {
  TEXT: 6_000,
  IMAGE: 30_000,
  VIDEO: 60_000,
};

/** Gap between container status polls. */
const THREADS_CONTAINER_POLL_MS = 3_000;

/**
 * Wait for a Threads media container to finish processing.
 *
 * The Threads container reports `status` (not Instagram's `status_code`) and an
 * `error_message`, per the Threads troubleshooting guide.
 */
async function threadsContainerReady(
  containerId: string,
  token: string,
  mediaType: ThreadsMediaType
): Promise<"ready" | "failed" | "unknown"> {
  const deadline = Date.now() + THREADS_CONTAINER_BUDGET_MS[mediaType];

  for (;;) {
    try {
      const res = await fetch(
        `${GRAPH_THREADS}/${containerId}?fields=status,error_message&access_token=${encodeURIComponent(token)}`
      );
      if (res.ok) {
        const { status, error_message } = (await res.json()) as {
          status?: string;
          error_message?: string;
        };
        if (status === "FINISHED" || status === "PUBLISHED") return "ready";
        if (status === "ERROR" || status === "EXPIRED") {
          if (error_message) {
            console.warn(`[threads] container ${containerId} failed: ${error_message}`);
          }
          return "failed";
        }
      }
    } catch {
      // Fall through to the delay: publishing may still succeed.
    }

    if (Date.now() >= deadline) return "unknown";
    await delay(THREADS_CONTAINER_POLL_MS);
  }
}

/** Public permalink of a published Threads post (best effort, see Instagram). */
async function threadsPermalink(
  mediaId: string,
  token: string
): Promise<string | undefined> {
  try {
    const res = await fetch(
      `${GRAPH_THREADS}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token)}`
    );
    if (!res.ok) return undefined;
    const { permalink } = (await res.json()) as { permalink?: string };
    return permalink;
  } catch {
    return undefined;
  }
}

/**
 * Publish to Threads via the Threads API.
 * Same container flow as Instagram: create container → wait → publish.
 *
 * Text-only posts are supported here (500-character limit), images take
 * `image_url`, and video takes `video_url`.
 *
 * Docs: POST /{threads-user-id}/threads → POST /{threads-user-id}/threads_publish
 */
async function publishToThreads(userId: string, text: string, imageUrl?: string): Promise<PublishResult> {
  const account = await getConnectedAccount(userId, "threads");
  if (!account) {
    return { platform: "threads", success: false, error: "Threads not connected" };
  }

  const maxLength = PLATFORM_REGISTRY.threads.content.maxTextLength;
  if (maxLength !== null && text.length > maxLength) {
    return {
      platform: "threads",
      success: false,
      error: `Threads posts are limited to ${maxLength} characters (got ${text.length})`,
    };
  }

  const token = account.accessToken;
  const threadsUserId = account.platformAccountId;
  const mediaType = threadsMediaType(imageUrl);

  try {
    // Step 1: create the container. The media URL field is named after the
    // media type — sending a video URL as `image_url` (or vice versa) fails.
    const containerParams: Record<string, string> = {
      media_type: mediaType,
      text,
      access_token: token,
    };
    if (imageUrl && mediaType === "IMAGE") containerParams.image_url = imageUrl;
    if (imageUrl && mediaType === "VIDEO") containerParams.video_url = imageUrl;

    const containerRes = await fetch(`${GRAPH_THREADS}/${threadsUserId}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(containerParams).toString(),
    });

    if (!containerRes.ok) {
      const err = (await containerRes.json().catch(() => ({}))) as GraphError;
      return {
        platform: "threads",
        success: false,
        error: err.error?.message || `Container creation failed: ${containerRes.status}`,
      };
    }

    const { id: containerId } = (await containerRes.json()) as { id?: string };
    if (!containerId) {
      return { platform: "threads", success: false, error: "Threads returned no media container" };
    }

    // Step 2: wait for the container to finish processing.
    const ready = await threadsContainerReady(containerId, token, mediaType);
    if (ready === "failed") {
      return {
        platform: "threads",
        success: false,
        error: "Threads could not process the media — check that the media URL is public",
      };
    }

    // Step 3: publish the container.
    const publishRes = await fetch(`${GRAPH_THREADS}/${threadsUserId}/threads_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        creation_id: containerId,
        access_token: token,
      }).toString(),
    });

    if (!publishRes.ok) {
      const err = (await publishRes.json().catch(() => ({}))) as GraphError;
      return {
        platform: "threads",
        success: false,
        error: err.error?.message || `Publish failed: ${publishRes.status}`,
      };
    }

    const { id: mediaId } = (await publishRes.json()) as { id?: string };
    return {
      platform: "threads",
      success: true,
      postId: mediaId,
      url: mediaId
        ? await threadsPermalink(mediaId, token)
        : undefined,
    };
  } catch (e) {
    return { platform: "threads", success: false, error: errorMessage(e, "Threads publish failed") };
  }
}

/**
 * Main publish function — routes to the right platform connector.
 */
export async function publishPost(
  platform: string,
  text: string,
  imageUrl?: string
): Promise<PublishResult> {
  const session = await getSessionUser();
  if (!session) return { platform, success: false, error: "Not signed in" };

  switch (platform) {
    case "instagram":
      return publishToInstagram(session.id, text, imageUrl);
    case "facebook":
      return publishToFacebook(session.id, text, imageUrl);
    case "x":
      return publishToX(session.id, text);
    case "threads":
      return publishToThreads(session.id, text, imageUrl);
    default:
      return {
        platform,
        success: false,
        error: `Publishing not yet supported for ${platform}`,
      };
  }
}

/**
 * Publish to all connected platforms at once.
 */
export async function publishToAll(
  text: string,
  imageUrl?: string,
  platforms?: string[]
): Promise<PublishResult[]> {
  const session = await getSessionUser();
  if (!session) return [{ platform: "all", success: false, error: "Not signed in" }];

  const targetPlatforms = platforms ?? ["instagram", "facebook", "x", "threads"];
  const results = await Promise.all(
    targetPlatforms.map((p) => publishPost(p, text, imageUrl))
  );
  return results;
}