import "server-only";

import { sanitizePublishResult } from "../result-url";
import { getPublishingCapability } from "../platforms";
import { errorMessage } from "./shared";
import { getSessionUser } from "../session";

import { publishToFacebook } from "./facebook";
import { publishToInstagram } from "./instagram";
import { publishToTelegram, telegramApi } from "./telegram";
import { publishToThreads } from "./threads";
import { publishToX } from "./x";
import type { PublishResult } from "./types";

export { telegramApi } from "./telegram";
export type { TelegramApiResult, TelegramMessage } from "./telegram";
export type { PublishResult } from "./types";

/** Platforms `publishToAll` targets when the caller doesn't name any. */
const DEFAULT_TARGET_PLATFORMS = ["instagram", "facebook", "x", "threads"];

/**
 * Route one platform to its connector on behalf of a specific user.
 *
 * The user id is passed in rather than taken from the session because the
 * scheduled-post runner publishes for users who are not making a request —
 * a cron invocation has no session cookie.
 *
 * Exported for the legacy connector adapter in `@/lib/connectors`, which is the
 * only other caller. New code should go through the connector registry instead.
 *
 * Every result passes through `sanitizePublishResult` before leaving this
 * module: connector outputs are third-party API data, and Task 7/11 of the
 * remediation plan requires result URLs and text fields to be validated
 * server-side before they are rendered or persisted.
 */
export async function publishForUser(
  userId: string,
  platform: string,
  text: string,
  imageUrl?: string,
  accountKey?: string
): Promise<PublishResult> {
  return sanitizePublishResult(
    await routePublishForUser(userId, platform, text, imageUrl, accountKey)
  );
}

async function routePublishForUser(
  userId: string,
  platform: string,
  text: string,
  imageUrl?: string,
  accountKey?: string
): Promise<PublishResult> {
  switch (platform) {
    case "instagram":
      return publishToInstagram(userId, text, imageUrl, accountKey);
    case "facebook":
      return publishToFacebook(userId, text, imageUrl, accountKey);
    case "x":
      return publishToX(userId, text, accountKey);
    case "threads":
      return publishToThreads(userId, text, imageUrl, accountKey);
    case "telegram":
      return publishToTelegram(userId, text, imageUrl, accountKey);
    default: {
      const capability = getPublishingCapability(platform);
      return {
        platform,
        success: false,
        error:
          capability?.note ??
          `Publishing not yet supported for ${platform}`,
      };
    }
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
  platforms?: string[],
  publish: (
    userId: string,
    platform: string,
    text: string,
    imageUrl?: string,
  ) => Promise<PublishResult> = publishForUser,
): Promise<PublishResult[]> {
  const targetPlatforms = platforms ?? DEFAULT_TARGET_PLATFORMS;
  const settled = await Promise.allSettled(
    targetPlatforms.map((platform) => publish(userId, platform, text, imageUrl)),
  );

  return settled.map((result, index) => {
    if (result.status === "fulfilled") return sanitizePublishResult(result.value);
    return sanitizePublishResult({
      platform: targetPlatforms[index] ?? "unknown",
      success: false,
      error: errorMessage(result.reason, "Publish failed"),
    });
  });
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
