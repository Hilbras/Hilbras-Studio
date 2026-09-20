"use server";

import { randomUUID } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db";
import { posts, socialAccounts } from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { publishDuePosts } from "@/lib/scheduled-posts";

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

  if (!content.trim()) return { error: "Content is required" };
  if (!platforms.length) return { error: "Select at least one platform" };

  const postId = randomUUID();
  await db.insert(posts).values({
    id: postId,
    userId: session.id,
    content: content.trim(),
    imageUrl: imageUrl || null,
    platforms: platforms.join(","),
    status: scheduledAt ? "scheduled" : "draft",
    scheduledAt: scheduledAt || null,
  });

  return { success: scheduledAt ? "Post scheduled" : "Draft saved", postId };
}

/** Mark a post as published and store the results. */
export async function markPublished(
  postId: string,
  results: Array<{ platform: string; success: boolean; error?: string }>
): Promise<void> {
  const session = await getSessionUser();
  if (!session) return;

  await db
    .update(posts)
    .set({
      status: "published",
      results: JSON.stringify(results),
      publishedAt: new Date(),
    })
    .where(and(eq(posts.id, postId), eq(posts.userId, session.id)));
}

/** List posts for the current user. */
export async function listPosts(status?: string): Promise<PostItem[]> {
  const session = await getSessionUser();
  if (!session) return [];

  const conditions = status
    ? and(eq(posts.userId, session.id), eq(posts.status, status))
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

  await db
    .delete(posts)
    .where(and(eq(posts.id, postId), eq(posts.userId, session.id)));

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