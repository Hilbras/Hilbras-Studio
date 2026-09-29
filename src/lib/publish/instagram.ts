import "server-only";

import { fetchWithTimeout } from "../http";
import { sanitizeResultUrl } from "../result-url";

import {
  connectionError,
  delay,
  errorMessage,
  getConnectedAccount,
  graphErrorMessage,
  GRAPH_INSTAGRAM,
} from "./shared";
import type { GraphError } from "./shared";
import type { PublishResult } from "./types";

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
      const res = await fetchWithTimeout(
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
    const res = await fetchWithTimeout(
      `${GRAPH_INSTAGRAM}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token)}`
    );
    if (!res.ok) return undefined;
    const { permalink } = (await res.json()) as { permalink?: string };
    return sanitizeResultUrl("instagram", permalink);
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
export async function publishToInstagram(userId: string, text: string, imageUrl?: string, accountKey?: string): Promise<PublishResult> {
  const account = await getConnectedAccount(userId, "instagram", accountKey);
  if (!account.ok) {
    return { platform: "instagram", success: false, error: connectionError("instagram", account.problem) };
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
    const containerRes = await fetchWithTimeout(`${GRAPH_INSTAGRAM}/${igUserId}/media`, {
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
        error: graphErrorMessage("instagram", err, `Container creation failed: ${containerRes.status}`),
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
    const publishRes = await fetchWithTimeout(`${GRAPH_INSTAGRAM}/${igUserId}/media_publish`, {
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
        error: graphErrorMessage("instagram", err, `Publish failed: ${publishRes.status}`),
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
