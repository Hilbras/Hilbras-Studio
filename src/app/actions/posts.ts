"use server";

import { randomUUID } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { posts, socialAccounts } from "@/db/schema";
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

const outcomeInput = z.object({
  postId: idSchema,
  results: z
    .array(
      z.object({
        platform: z.string().max(30),
        success: z.boolean(),
        error: z.string().max(1000).optional(),
        url: z.string().max(2048).optional(),
        postId: z.string().max(64).optional(),
      })
    )
    .max(10),
});

/** Status filters are plain words — bounded and stripped of anything else. */
const statusFilter = z
  .string()
  .max(20)
  .regex(/^[a-z_]*$/)
  .optional()
  .catch(undefined);

export interface PostItem {
  id: string;
  content: string;
  imageUrl: string | null;
  platforms: string;
  status: string;
  scheduledAt: string | null;
  results: string | null;
  createdAt: string;
  publishedAt: string | null;
}

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

  const postId = randomUUID();
  await db.insert(posts).values({
    id: postId,
    userId: session.id,
    content: input.content,
    imageUrl: input.imageUrl || null,
    platforms: input.platforms.join(","),
    status: scheduled ? "scheduled" : "draft",
    scheduledAt: scheduled,
  });

  return { success: scheduled ? "Post scheduled" : "Draft saved", postId };
}

/**
 * Write a post's terminal state after a Composer publish attempt — the twin of
 * `finalize` in `@/lib/scheduled-posts`, and deliberately the same rule: a post
 * counts as published when **at least one** platform accepted it, while every
 * platform failing leaves it `failed`.
 *
 * Marking the row `published` regardless of the outcome used to be the behaviour
 * here, which made a Threads post with a refused permission grant show up as live
 * in the queue it never reached. `results` keeps the per-platform reason, so the
 * queue can explain the failure.
 */
export async function recordPublishOutcome(
  postId: string,
  results: Array<{ platform: string; success: boolean; error?: string }>
): Promise<void> {
  const session = await getSessionUser();
  if (!session) return;

  const parsed = outcomeInput.safeParse({ postId, results });
  if (!parsed.success) return;

  const ok = parsed.data.results.some((r) => r.success);

  await db
    .update(posts)
    .set({
      status: ok ? "published" : "failed",
      results: JSON.stringify(parsed.data.results),
      publishedAt: ok ? new Date() : null,
    })
    .where(and(eq(posts.id, parsed.data.postId), eq(posts.userId, session.id)));
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

  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    imageUrl: r.imageUrl,
    platforms: r.platforms,
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

  const rows = await db
    .select({ platform: socialAccounts.platform })
    .from(socialAccounts)
    .where(eq(socialAccounts.userId, session.id));

  return rows.map((r) => r.platform);
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

  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    imageUrl: r.imageUrl,
    platforms: r.platforms,
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