import "server-only";

import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db";
import { socialAccounts } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { PLATFORM_REGISTRY } from "@/lib/platforms";
import {
  DEFAULT_TOKEN_LIFETIME_SECONDS,
  effectiveTokenExpiry,
  isExpiredSessionError,
  refreshLongLivedToken,
  supportsTokenRefresh,
  TOKEN_REFRESH_WINDOW_MS,
  tokenExpiredMessage,
} from "@/lib/platform-tokens";
import { isThreadsPermissionError, THREADS_PERMISSION_FIX } from "@/lib/threads-errors";
import { getSessionUser } from "@/lib/session";

export interface PublishResult {
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
const GRAPH_FACEBOOK = "https://graph.facebook.com/v26.0";
const GRAPH_INSTAGRAM = "https://graph.instagram.com/v25.0";
const GRAPH_THREADS = "https://graph.threads.net/v1.0";

/** One Bot API root — every call is `<root>/bot<token>/<method>`. */
const TELEGRAM_API = "https://api.telegram.org";

/** Shape of a Telegram Bot API answer. */
export type TelegramApiResult<T> =
  | { ok: true; result: T }
  | { ok: false; description: string };

/** The message Telegram posted — the fields the result link and split need. */
export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string; username?: string };
}

/**
 * One Telegram Bot API call.
 *
 * Exported because the Accounts connect action validates the very same
 * endpoints (`getMe` / `getChat` / `getChatMember`) and must see Telegram's
 * own `description` to phrase a connect-specific error — callers map that raw
 * text themselves (`friendlyTelegramError` for publishing).
 */
export async function telegramApi<T>(
  token: string,
  method: string,
  payload: Record<string, unknown>
): Promise<TelegramApiResult<T>> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
    };
    if (!body.ok || body.result === undefined || body.result === null) {
      return {
        ok: false,
        description: body.description || `Telegram returned HTTP ${res.status}`,
      };
    }
    return { ok: true, result: body.result };
  } catch (e) {
    return { ok: false, description: errorMessage(e, "Could not reach Telegram") };
  }
}

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number };
}

/** A connection that is stored but cannot publish, and why. */
type ConnectionProblem = "not_connected" | "expired";

type AccountLookup =
  | { ok: true; accessToken: string; platformAccountId: string }
  | { ok: false; problem: ConnectionProblem };

/** Publish failure for an unusable connection — the two cases worth naming. */
function connectionError(platform: string, problem: ConnectionProblem): string {
  const name = platform.charAt(0).toUpperCase() + platform.slice(1);
  return problem === "expired" ? tokenExpiredMessage(platform) : `${name} not connected`;
}

/**
 * Read the platform's own message out of a Graph error, rephrasing the one
 * case where we know the fix better than Meta's wording does: an expired
 * session, which Meta reports verbatim as `Error validating access token:
 * Session has expired on …` and which only a reconnect can repair.
 */
function graphErrorMessage(platform: string, err: GraphError, fallback: string): string {
  if (isExpiredSessionError(err)) return tokenExpiredMessage(platform);
  return err.error?.message || fallback;
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
 * Load the connection for a platform. Newest row wins, so a connection made
 * before reconnects replaced rows instead of appending them can't shadow it.
 *
 * Returns `{ ok: false, problem }` for the two states a publish cannot work
 * from — no connection, or one whose session has expired — and refreshes the
 * long-lived token on the way out when it is inside `TOKEN_REFRESH_WINDOW_MS`.
 * Nothing else ever acts on `tokenExpiresAt`, so without this check the
 * connection would silently die ~60 days after connect.
 */
async function getConnectedAccount(
  userId: string,
  platform: string
): Promise<AccountLookup> {
  const [account] = await db
    .select({
      id: socialAccounts.id,
      accessTokenEnc: socialAccounts.accessTokenEnc,
      platformAccountId: socialAccounts.platformAccountId,
      tokenExpiresAt: socialAccounts.tokenExpiresAt,
      connectedAt: socialAccounts.connectedAt,
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

  if (!account?.accessTokenEnc) return { ok: false, problem: "not_connected" };

  let accessToken: string;
  try {
    accessToken = decryptSecret(account.accessTokenEnc);
  } catch {
    return { ok: false, problem: "not_connected" };
  }

  // Nothing else ever acts on `tokenExpiresAt`, so this is the only place a
  // connection notices it is running out. An expired token is reported here
  // rather than sent to the platform: Meta would answer with the same verdict
  // (`code 190 / subcode 463`), only later and in its own words.
  const expiresAt = effectiveTokenExpiry(platform, account.tokenExpiresAt, account.connectedAt);
  if (expiresAt) {
    const msLeft = expiresAt.getTime() - Date.now();
    if (msLeft <= 0) return { ok: false, problem: "expired" };

    if (msLeft < TOKEN_REFRESH_WINDOW_MS && supportsTokenRefresh(platform)) {
      const refreshed = await refreshLongLivedToken(platform, accessToken);
      if (refreshed) {
        accessToken = refreshed.accessToken;
        const newExpiry = new Date(
          Date.now() +
            (refreshed.expiresIn ?? DEFAULT_TOKEN_LIFETIME_SECONDS) * 1000
        );
        await db
          .update(socialAccounts)
          .set({
            accessTokenEnc: encryptSecret(accessToken),
            tokenExpiresAt: newExpiry,
          })
          .where(eq(socialAccounts.id, account.id));
      }
      // A failed refresh keeps the still-valid old token: the window is wide
      // enough that the next publish or cron run gets another attempt.
    }
  }

  return { ok: true, accessToken, platformAccountId: account.platformAccountId };
}

/** Container states reported by `GET /<container>?fields=status_code`. */
type ContainerStatus = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

/** Telegram's raw failure, rephrased as something the user can act on. */
function friendlyTelegramError(description: string): string {
  if (/chat not found|wrong chat id/i.test(description)) {
    return "Chat not found — check the chat ID and that the bot is still a member of it.";
  }
  if (/not enough rights|have no rights|can'?t send (messages|photos|videos)/i.test(description)) {
    return "The bot does not have the right to post in that chat — make it an administrator with permission to post messages.";
  }
  if (/bot was kicked|bot is not a member|user is deactivated/i.test(description)) {
    return "The bot was removed from the chat — add it back and publish again.";
  }
  if (/peer_id_invalid/i.test(description)) {
    return "Telegram does not know that chat — send the bot a message first, or use the chat's @username.";
  }
  if (/wrong file identifier|failed to get/i.test(description)) {
    return "Telegram could not fetch the media — the URL must be publicly reachable.";
  }
  return `Telegram: ${description}`;
}

/**
 * Split long text into messages of at most 4096 characters, preferring newline
 * boundaries — a mid-word cut is how a scheduled post silently loses its shape.
 */
function splitTelegramMessage(text: string, limit = 4096): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit / 2)) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Send `text` as one or more messages and return the last one posted. */
async function sendTelegramText(
  token: string,
  chatId: string,
  text: string
): Promise<TelegramApiResult<TelegramMessage>> {
  let last: TelegramMessage | null = null;
  for (const chunk of splitTelegramMessage(text)) {
    const sent = await telegramApi<TelegramMessage>(token, "sendMessage", {
      chat_id: chatId,
      text: chunk,
    });
    if (!sent.ok) return sent;
    last = sent.result;
  }
  if (!last) return { ok: false, description: "Nothing to send" };
  return { ok: true, result: last };
}

/** Permalink for public chats — private chats and groups have no t.me link. */
function telegramPermalink(message: TelegramMessage): string | undefined {
  return message.chat.username
    ? `https://t.me/${message.chat.username}/${message.message_id}`
    : undefined;
}

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
 * Publish through the Telegram Bot API.
 *
 * The connection stores the bot token as `accessToken_enc` and the chat's
 * numeric id as `platform_account_id`; `tokenExpiresAt` stays null because bot
 * tokens do not expire (`effectiveTokenExpiry` leaves an unknown expiry null
 * for platforms outside its refresh list, so nothing ever tries to "refresh").
 *
 * Media captions cap at 1024 characters — longer text follows the media as its
 * own message instead of being truncated. Video URLs are detected by extension
 * and sent with `sendVideo`; everything else goes through `sendPhoto`.
 */
async function publishToTelegram(
  userId: string,
  text: string,
  imageUrl?: string
): Promise<PublishResult> {
  const account = await getConnectedAccount(userId, "telegram");
  if (!account.ok) {
    return {
      platform: "telegram",
      success: false,
      error: connectionError("telegram", account.problem),
    };
  }
  if (!text.trim() && !imageUrl) {
    return {
      platform: "telegram",
      success: false,
      error: "Nothing to publish — the post is empty.",
    };
  }

  const token = account.accessToken;
  const chatId = account.platformAccountId;
  const fail = (description: string): PublishResult => ({
    platform: "telegram",
    success: false,
    error: friendlyTelegramError(description),
  });

  if (imageUrl) {
    const isVideo = /\.(mp4|mov|webm|mkv|avi)(\?|#|$)/i.test(imageUrl);
    const mediaMethod = isVideo ? "sendVideo" : "sendPhoto";
    const mediaParam = isVideo ? "video" : "photo";

    if (text.length <= 1024) {
      const media = await telegramApi<TelegramMessage>(token, mediaMethod, {
        chat_id: chatId,
        [mediaParam]: imageUrl,
        ...(text ? { caption: text } : {}),
      });
      if (!media.ok) return fail(media.description);
      return {
        platform: "telegram",
        success: true,
        postId: String(media.result.message_id),
        url: telegramPermalink(media.result),
      };
    }

    // Over the caption limit: the media goes out first, the full text follows
    // as its own message — nothing is cut, and the pair reads naturally.
    const media = await telegramApi<TelegramMessage>(token, mediaMethod, {
      chat_id: chatId,
      [mediaParam]: imageUrl,
    });
    if (!media.ok) return fail(media.description);

    const followUp = await sendTelegramText(token, chatId, text);
    if (!followUp.ok) {
      return {
        platform: "telegram",
        success: false,
        error: `Posted the media, but the text follow-up failed: ${friendlyTelegramError(followUp.description)}`,
      };
    }
    return {
      platform: "telegram",
      success: true,
      postId: String(media.result.message_id),
      url: telegramPermalink(media.result),
    };
  }

  const sent = await sendTelegramText(token, chatId, text);
  if (!sent.ok) return fail(sent.description);
  return {
    platform: "telegram",
    success: true,
    postId: String(sent.result.message_id),
    url: telegramPermalink(sent.result),
  };
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

/**
 * Publish to Facebook Pages via Graph API.
 */
async function publishToFacebook(userId: string, text: string, imageUrl?: string): Promise<PublishResult> {
  const account = await getConnectedAccount(userId, "facebook");
  if (!account.ok) {
    return { platform: "facebook", success: false, error: connectionError("facebook", account.problem) };
  }
  const token = account.accessToken;

  try {
    // Get user's pages
    const pagesRes = await fetch(
      `${GRAPH_FACEBOOK}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(token)}`
    );
    if (!pagesRes.ok) {
      const err = (await pagesRes.json().catch(() => ({}))) as GraphError;
      return {
        platform: "facebook",
        success: false,
        error: graphErrorMessage("facebook", err, `Failed to get pages: ${pagesRes.status}`),
      };
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
      const err = await publishRes.json() as GraphError;
      return {
        platform: "facebook",
        success: false,
        error: graphErrorMessage("facebook", err, `Publish failed: ${publishRes.status}`),
      };
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
  const account = await getConnectedAccount(userId, "x");
  if (!account.ok) {
    return { platform: "x", success: false, error: connectionError("x", account.problem) };
  }

  try {
    const res = await fetch("https://api.x.com/2/tweets", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${account.accessToken}`,
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

    const containerRes = await fetch(`${GRAPH_THREADS}/${threadsUserId}/threads`, {
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

/** Platforms `publishToAll` targets when the caller doesn't name any. */
const DEFAULT_TARGET_PLATFORMS = ["instagram", "facebook", "x", "threads"];

/**
 * Route one platform to its connector on behalf of a specific user.
 *
 * The user id is passed in rather than taken from the session because the
 * scheduled-post runner publishes for users who are not making a request —
 * a cron invocation has no session cookie.
 */
async function publishForUser(
  userId: string,
  platform: string,
  text: string,
  imageUrl?: string
): Promise<PublishResult> {
  switch (platform) {
    case "instagram":
      return publishToInstagram(userId, text, imageUrl);
    case "facebook":
      return publishToFacebook(userId, text, imageUrl);
    case "x":
      return publishToX(userId, text);
    case "threads":
      return publishToThreads(userId, text, imageUrl);
    case "telegram":
      return publishToTelegram(userId, text, imageUrl);
    default:
      return {
        platform,
        success: false,
        error: `Publishing not yet supported for ${platform}`,
      };
  }
}

/**
 * Publish to several platforms as a specific user, with no session involved.
 *
 * Only for trusted server callers (the scheduled-post runner). The user id comes
 * from the caller, so this must never be reachable from the browser: the file is
 * a plain server module rather than a `"use server"` one for exactly that reason.
 */
export async function publishToAllForUser(
  userId: string,
  text: string,
  imageUrl?: string,
  platforms?: string[]
): Promise<PublishResult[]> {
  const targetPlatforms = platforms ?? DEFAULT_TARGET_PLATFORMS;
  return Promise.all(
    targetPlatforms.map((p) => publishForUser(userId, p, text, imageUrl))
  );
}

/**
 * Main publish function — routes to the right platform connector for the
 * signed-in user.
 */
export async function publishPost(
  platform: string,
  text: string,
  imageUrl?: string
): Promise<PublishResult> {
  const session = await getSessionUser();
  if (!session) return { platform, success: false, error: "Not signed in" };

  return publishForUser(session.id, platform, text, imageUrl);
}

/**
 * Publish to all connected platforms at once for the signed-in user.
 */
export async function publishToAll(
  text: string,
  imageUrl?: string,
  platforms?: string[]
): Promise<PublishResult[]> {
  const session = await getSessionUser();
  if (!session) return [{ platform: "all", success: false, error: "Not signed in" }];

  return publishToAllForUser(session.id, text, imageUrl, platforms);
}