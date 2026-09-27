"use server";

import { z } from "zod";

import { publishPost, publishToAll, type PublishResult } from "@/lib/publish";
import { getSessionUser } from "@/lib/session";
import { db } from "@/db";
import { posts } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export interface PublishActionState {
  error?: string;
  success?: string;
  results?: Array<{ platform: string; success: boolean; postId?: string; error?: string; url?: string }>;
}

const textSchema = z
  .string()
  .trim()
  .min(1, "Post content is required")
  .max(5000, "Post is too long (5000 characters max)");
const platformSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,29}$/, "Select a platform");
const platformsSchema = z
  .array(platformSchema)
  .min(1, "Select at least one platform")
  .max(10);
const imageUrlSchema = z
  .union([z.string().url("Media must be a valid URL").max(2048), z.literal("")])
  .optional();

/** FormData entries can be File or null — only strings count as fields. */
function asString(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v : "";
}

export async function publishPostAction(
  _prev: PublishActionState,
  formData: FormData
): Promise<PublishActionState> {
  const parsed = z
    .object({ platform: platformSchema, text: textSchema, imageUrl: imageUrlSchema })
    .safeParse({
      platform: asString(formData.get("platform")),
      text: asString(formData.get("text")),
      imageUrl: asString(formData.get("imageUrl")),
    });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { platform, text, imageUrl } = parsed.data;
  const result = await publishPost(platform, text, imageUrl || undefined);

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
  const parsed = z
    .object({ text: textSchema, platforms: platformsSchema, imageUrl: imageUrlSchema })
    .safeParse({
      text: asString(formData.get("text")),
      platforms: formData
        .getAll("platforms")
        .filter((p): p is string => typeof p === "string"),
      imageUrl: asString(formData.get("imageUrl")),
    });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { text, platforms, imageUrl } = parsed.data;
  const results = await publishToAll(text, imageUrl || undefined, platforms);
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
  const parsed = z
    .object({ platform: platformSchema, text: textSchema, imageUrl: imageUrlSchema })
    .safeParse({ platform, text, imageUrl });
  if (!parsed.success) {
    return [
      {
        platform: typeof platform === "string" ? platform.slice(0, 30) : "unknown",
        success: false,
        error: parsed.error.issues[0]?.message ?? "Invalid input",
      },
    ];
  }

  return [
    await publishPost(parsed.data.platform, parsed.data.text, parsed.data.imageUrl || undefined),
  ];
}

/**
 * Publish the current Composer draft and persist the server-produced result in
 * one server action.
 *
 * The browser must not submit the success flag or provider URL that decides a
 * post's terminal state. Those values come from the connector response here,
 * scoped to the post and authenticated user.
 */
export async function publishComposerDraftAction(
  postId: string,
  text: string,
  imageUrl?: string,
  platforms?: string[],
): Promise<PublishResult[]> {
  const parsed = z
    .object({
      postId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid post id"),
      text: textSchema,
      imageUrl: imageUrlSchema,
      platforms: platformsSchema,
    })
    .safeParse({ postId, text, imageUrl, platforms: platforms ?? [] });
  if (!parsed.success) {
    return [
      {
        platform: "all",
        success: false,
        error: parsed.error.issues[0]?.message ?? "Invalid input",
      },
    ];
  }

  const session = await getSessionUser();
  if (!session) {
    return [{ platform: "all", success: false, error: "Not signed in" }];
  }

  const [post] = await db
    .select({ id: posts.id, status: posts.status })
    .from(posts)
    .where(
      and(
        eq(posts.id, parsed.data.postId),
        eq(posts.userId, session.id),
        eq(posts.status, "draft"),
      ),
    )
    .limit(1);
  if (!post) {
    return [{ platform: "all", success: false, error: "Post is not available" }];
  }

  try {
    // The client may retry after a network error. Only a still-unsuccessful
    // draft is eligible; a post already finalized by an earlier attempt must
    // not receive a second platform call.
    const results = await publishToAll(
      parsed.data.text,
      parsed.data.imageUrl || undefined,
      parsed.data.platforms,
    );
    const ok = results.some((result) => result.success);

    await db
      .update(posts)
      .set({
        status: ok ? "published" : "failed",
        results: JSON.stringify(results),
        publishedAt: ok ? new Date() : null,
      })
      .where(
        and(
          eq(posts.id, post.id),
          eq(posts.userId, session.id),
          eq(posts.status, "draft"),
        ),
      );

    return results;
  } catch (error) {
    return [
      {
        platform: "all",
        success: false,
        error:
          error instanceof Error && error.message
            ? error.message
            : "Publish failed",
      },
    ];
  }
}