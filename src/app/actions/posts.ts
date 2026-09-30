"use server";

import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { posts } from "@/db/schema";
import { listConnectedPlatforms } from "@/lib/accounts/store";
import { createPost } from "@/lib/posts/service";
import { getPostTargets, type PostItem } from "@/lib/posts/targets";
import { getSessionUser } from "@/lib/session";
import { publishDuePosts } from "@/lib/scheduled-posts";

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id");
const contentSchema = z
  .string()
  .trim()
  .min(1, "Content is required")
  .max(10000, "Content is too long");
const platformsList = z
  .array(z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/))
  .min(1, "Select at least one platform")
  .max(10);
const mediaUrlSchema = z.union([
  z.string().url("Media must be a valid URL").max(2048),
  z.literal(""),
]);

const createPostInput = z.object({
  content: contentSchema,
  platforms: platformsList,
  imageUrl: mediaUrlSchema.nullish(),
  scheduledAt: z.date().nullish(),
});

/** Status filters are plain words — bounded and stripped of anything else. */
const statusFilter = z
  .string()
  .max(20)
  .regex(/^[a-z_]*$/)
  .optional()
  .catch(undefined);

// `PostItem` is a post row joined with its targets, and `posts/targets.ts` is
// the only module that knows how those two are read together — `posts.platforms`
// is gone (migration 0011). So the shape is declared there and re-exported here.
// A `"use server"` module may only export async functions, so declaring a shape
// here puts a contract in a module whose contract does not describe shapes
// (remediation Task 17).
export type { PostItem };

/**
 * What a post form reports back.
 *
 * Unlike the DTOs above this one *does* belong to the action: it is the shape
 * `useActionState` holds for this action's own result, and no service returns
 * it. A form state is the action's contract with its own form, which is the one
 * thing a `"use server"` module legitimately describes.
 */
export interface PostFormState {
  error?: string;
  success?: string;
  postId?: string;
}

/** Create a new post (draft or scheduled). */
export async function createPostAction(
  content: string,
  platforms: string[],
  imageUrl?: string,
  scheduledAt?: Date
): Promise<PostFormState> {
  const session = await getSessionUser();
  if (!session) return { error: "Not signed in" };

  const parsed = createPostInput.safeParse({ content, platforms, imageUrl, scheduledAt });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const input = parsed.data;
  const scheduled = input.scheduledAt ?? null;

  // The post and its targets are one fact — created together or not at all.
  const postId = await createPost({
    userId: session.id,
    content: input.content,
    platforms: input.platforms,
    imageUrl: input.imageUrl,
    scheduledAt: scheduled,
  });

  return { success: scheduled ? "Post scheduled" : "Draft saved", postId };
}

/** List posts for the current user. */
export async function listPosts(status?: string): Promise<PostItem[]> {
  const session = await getSessionUser();
  if (!session) return [];

  const safeStatus = statusFilter.parse(status);
  const conditions = safeStatus
    ? and(eq(posts.userId, session.id), eq(posts.status, safeStatus))
    : eq(posts.userId, session.id);

  const rows = await db
    .select()
    .from(posts)
    .where(conditions)
    .orderBy(desc(posts.createdAt))
    .limit(50);

  const targets = await getPostTargets(rows.map((r) => r.id));

  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    imageUrl: r.imageUrl,
    platforms: targets.get(r.id) ?? [],
    status: r.status,
    scheduledAt: r.scheduledAt?.toISOString() ?? null,
    results: r.results,
    createdAt: r.createdAt.toISOString(),
    publishedAt: r.publishedAt?.toISOString() ?? null,
  }));
}

/** Get list of connected platform IDs for the current user. */
export async function getConnectedPlatforms(): Promise<string[]> {
  const session = await getSessionUser();
  if (!session) return [];

  return listConnectedPlatforms(session.id);
}

/** Check which platforms have credentials configured (but may not have OAuth yet). */
export async function getConfiguredPlatforms(): Promise<string[]> {
  const session = await getSessionUser();
  if (!session) return [];

  const { storedCredentials } = await import("@/db/schema");
  const rows = await db
    .select({ keyName: storedCredentials.keyName })
    .from(storedCredentials)
    .where(eq(storedCredentials.userId, session.id));

  const platformIds = new Set<string>();
  for (const row of rows) {
    if (row.keyName.endsWith("_client_id")) {
      platformIds.add(row.keyName.replace("_client_id", ""));
    }
  }

  return Array.from(platformIds);
}

/** Get scheduled posts for the current user. */
export async function getScheduledPosts(): Promise<PostItem[]> {
  const session = await getSessionUser();
  if (!session) return [];

  const rows = await db
    .select()
    .from(posts)
    .where(
      and(eq(posts.userId, session.id), eq(posts.status, "scheduled"))
    )
    .orderBy(desc(posts.scheduledAt));

  const targets = await getPostTargets(rows.map((r) => r.id));

  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    imageUrl: r.imageUrl,
    platforms: targets.get(r.id) ?? [],
    status: r.status,
    scheduledAt: r.scheduledAt?.toISOString() ?? null,
    results: r.results,
    createdAt: r.createdAt.toISOString(),
    publishedAt: r.publishedAt?.toISOString() ?? null,
  }));
}

/** Delete a post. */
export async function deletePost(postId: string): Promise<{ ok: boolean }> {
  const session = await getSessionUser();
  if (!session) return { ok: false };

  const parsed = idSchema.safeParse(postId);
  if (!parsed.success) return { ok: false };

  await db
    .delete(posts)
    .where(and(eq(posts.id, parsed.data), eq(posts.userId, session.id)));

  return { ok: true };
}

/** Summary the Scheduler's "Publish due now" button renders. */
export interface PublishDueResult {
  error?: string;
  processed?: number;
  published?: number;
  failed?: number;
}

/**
 * Publish every post that is due right now for the signed-in user.
 *
 * Backs the Scheduler's "Publish due now" button. Vercel's cron can only run once
 * a day on the Hobby plan, so this is how a due post goes out on time without an
 * upgrade — and it doubles as a manual catch-up after a failed run.
 */
export async function publishDuePostsAction(): Promise<PublishDueResult> {
  const session = await getSessionUser();
  if (!session) return { error: "Not signed in" };

  const summary = await publishDuePosts({ userId: session.id });

  return {
    processed: summary.processed,
    published: summary.published,
    failed: summary.failed,
  };
}
