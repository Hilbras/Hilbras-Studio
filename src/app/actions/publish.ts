"use server";

import { publishPost, publishToAll, type PublishResult } from "@/lib/publish";

export interface PublishActionState {
  error?: string;
  success?: string;
  results?: Array<{ platform: string; success: boolean; postId?: string; error?: string; url?: string }>;
}

export async function publishPostAction(
  _prev: PublishActionState,
  formData: FormData
): Promise<PublishActionState> {
  const platform = formData.get("platform") as string;
  const text = formData.get("text") as string;
  const imageUrl = (formData.get("imageUrl") as string) || undefined;

  if (!text?.trim()) {
    return { error: "Post content is required" };
  }
  if (!platform) {
    return { error: "Select a platform" };
  }

  const result = await publishPost(platform, text.trim(), imageUrl);

  if (result.success) {
    return {
      success: `Published to ${platform}${result.postId ? ` (${result.postId})` : ""}`,
      results: [result],
    };
  }

  return { error: result.error || "Failed to publish" };
}

export async function publishToAllAction(
  _prev: PublishActionState,
  formData: FormData
): Promise<PublishActionState> {
  const text = formData.get("text") as string;
  const imageUrl = (formData.get("imageUrl") as string) || undefined;
  const platforms = formData.getAll("platforms") as string[];

  if (!text?.trim()) {
    return { error: "Post content is required" };
  }
  if (!platforms.length) {
    return { error: "Select at least one platform" };
  }

  const results = await publishToAll(text.trim(), imageUrl, platforms);
  const successes = results.filter((r) => r.success);
  const failures = results.filter((r) => !r.success);

  if (failures.length === 0) {
    return {
      success: `Published to ${successes.length} platform(s)`,
      results,
    };
  }

  if (successes.length > 0) {
    return {
      success: `Published to ${successes.length} of ${results.length} platforms`,
      results,
    };
  }

  return {
    error: `Failed to publish: ${failures.map((f) => f.error).join("; ")}`,
    results,
  };
}

/**
 * Publish now, with positional arguments — what the Composer calls.
 *
 * `@/lib/publish` holds the platform HTTP connectors and is a plain server
 * module, so a client component cannot import it directly. These actions are the
 * client-facing entry points; both resolve the user from the session, so neither
 * can be aimed at another account.
 */
export async function publishPostNowAction(
  platform: string,
  text: string,
  imageUrl?: string
): Promise<PublishResult[]> {
  if (!text?.trim()) return [{ platform, success: false, error: "Post content is required" }];
  if (!platform) return [{ platform: "unknown", success: false, error: "Select a platform" }];

  return [await publishPost(platform, text.trim(), imageUrl)];
}

/** Publish one draft to several platforms now — the Composer's main path. */
export async function publishToAllNowAction(
  text: string,
  imageUrl?: string,
  platforms?: string[]
): Promise<PublishResult[]> {
  if (!text?.trim()) {
    return [{ platform: "all", success: false, error: "Post content is required" }];
  }
  if (!platforms?.length) {
    return [{ platform: "all", success: false, error: "Select at least one platform" }];
  }

  return publishToAll(text.trim(), imageUrl, platforms);
}