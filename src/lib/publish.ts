"use server";

import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db";
import { socialAccounts } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { PLATFORM_REGISTRY } from "@/lib/platforms";
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

/**
 * Load the connection for a platform. Newest row wins, so a connection made
 * before reconnects replaced rows instead of appending them can't shadow it.
 */
async function getConnectedAccount(
  userId: string,
  platform: string
): Promise<ConnectedAccount | null> {
  const [account] = await db
    .select({
      accessTokenEnc: socialAccounts.accessTokenEnc,
      platformAccountId: socialAccounts.platformAccountId,
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
  try {
    return {
      accessToken: decryptSecret(account.accessTokenEnc),
      platformAccountId: account.platformAccountId,
    };
  } catch {
    return null;
  }
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
    await new Promise((r) => setTimeout(r, 1500));
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

/**
 * Wait for a Threads media container to finish processing.
 *
 * The Threads container reports `status` (not Instagram's `status_code`) and an
 * `error_message`, per the Threads troubleshooting guide. Text containers are
 * normally FINISHED straight away; images can take longer.
 */
async function threadsContainerReady(
  containerId: string,
  token: string,
  attempts = 4
): Promise<"ready" | "failed" | "unknown"> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(
        `${GRAPH_THREADS}/${containerId}?fields=status,error_message&access_token=${encodeURIComponent(token)}`
      );
      if (res.ok) {
        const { status } = (await res.json()) as { status?: string };
        if (status === "FINISHED" || status === "PUBLISHED") return "ready";
        if (status === "ERROR" || status === "EXPIRED") return "failed";
      }
    } catch {
      // Fall through to the delay: publishing may still succeed.
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return "unknown";
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
 * Text-only posts are supported here (500-character limit).
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

  try {
    // Step 1: create the container. `media_type=TEXT` is text-only.
    const containerRes = await fetch(`${GRAPH_THREADS}/${threadsUserId}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        media_type: imageUrl ? "IMAGE" : "TEXT",
        text,
        ...(imageUrl ? { image_url: imageUrl } : {}),
        access_token: token,
      }).toString(),
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
    const ready = await threadsContainerReady(containerId, token);
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