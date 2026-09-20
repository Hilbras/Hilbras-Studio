"use server";

import { publishPost, publishToAll } from "@/lib/publish";

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