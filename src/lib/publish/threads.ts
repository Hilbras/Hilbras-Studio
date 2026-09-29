import "server-only";

import { fetchWithTimeout } from "../http";
import { sanitizeResultUrl } from "../result-url";
import { PLATFORM_REGISTRY } from "../platforms";
import { isThreadsPermissionError, THREADS_PERMISSION_FIX } from "../threads-errors";

import {
  connectionError,
  delay,
  errorMessage,
  getConnectedAccount,
  graphErrorMessage,
  GRAPH_THREADS,
} from "./shared";
import type { GraphError } from "./shared";
import type { PublishResult } from "./types";

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
      const res = await fetchWithTimeout(
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
    const res = await fetchWithTimeout(
      `${GRAPH_THREADS}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token)}`
    );
    if (!res.ok) return undefined;
    const { permalink } = (await res.json()) as { permalink?: string };
    return sanitizeResultUrl("threads", permalink);
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
export async function publishToThreads(userId: string, text: string, imageUrl?: string, accountKey?: string): Promise<PublishResult> {
  const account = await getConnectedAccount(userId, "threads", accountKey);
  if (!account.ok) {
    return { platform: "threads", success: false, error: connectionError("threads", account.problem) };
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

    const containerRes = await fetchWithTimeout(`${GRAPH_THREADS}/${threadsUserId}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(containerParams).toString(),
    });

    if (!containerRes.ok) {
      const err = (await containerRes.json().catch(() => ({}))) as GraphError;
      // An empty grant (no accepted Threads Tester role, or an unpublished app
      // whose permissions never passed App Review) answers every endpoint with
      // code 100 / error_subcode 10 — repeat the fix instead of Meta's wording,
      // which otherwise only says "submit for app review".
      if (isThreadsPermissionError(err)) {
        console.warn("[threads] publish blocked: the connection has no permission grant");
        return { platform: "threads", success: false, error: THREADS_PERMISSION_FIX };
      }
      return {
        platform: "threads",
        success: false,
        error: graphErrorMessage("threads", err, `Container creation failed: ${containerRes.status}`),
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
    const publishRes = await fetchWithTimeout(`${GRAPH_THREADS}/${threadsUserId}/threads_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        creation_id: containerId,
        access_token: token,
      }).toString(),
    });

    if (!publishRes.ok) {
      const err = (await publishRes.json().catch(() => ({}))) as GraphError;
      if (isThreadsPermissionError(err)) {
        // Reachable when the grant was revoked (or the tester role removed)
        // between creating the container and publishing it.
        console.warn("[threads] publish blocked: the connection has no permission grant");
        return { platform: "threads", success: false, error: THREADS_PERMISSION_FIX };
      }
      return {
        platform: "threads",
        success: false,
        error: graphErrorMessage("threads", err, `Publish failed: ${publishRes.status}`),
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
