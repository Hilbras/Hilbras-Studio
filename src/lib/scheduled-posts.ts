import "server-only";

import { and, asc, eq, isNotNull, lte } from "drizzle-orm";

import { db } from "@/db";
import { posts } from "@/db/schema";
import { publishToAllForUser, type PublishResult } from "@/lib/publish";

/**
 * Scheduled-post runner.
 *
 * The Composer saves queued posts with `status = "scheduled"` and a
 * `scheduled_at` timestamp, but nothing in a serverless deployment publishes them
 * on its own: Vercel functions only run in response to a request, so a due post
 * would otherwise sit in the queue forever. This module turns due posts into
 * published ones, and is driven from two places:
 *
 *   1. `GET /api/cron/publish-scheduled` — Vercel Cron, every user's queue
 *   2. `publishDuePostsAction` — the Scheduler's "Publish due now" button, scoped
 *      to the signed-in user (the way to publish on time on Vercel's Hobby plan,
 *      where cron jobs may only run once a day)
 */

/**
 * Posts published per run. Publishing waits on Meta's media containers (30s image
 * / 60s video each), so a run is capped to stay inside the function timeout.
 */
const DEFAULT_BATCH_LIMIT = 10;

/**
 * A post left in `publishing` longer than this is treated as stranded — the
 * invocation that claimed it was killed before it could finish — and is put back
 * in the queue instead of staying stuck forever.
 */
const CLAIM_GRACE_MS = 10 * 60 * 1000;

export interface ScheduledPostOutcome {
  postId: string;
  userId: string;
  /** True when at least one platform accepted the post. */
  ok: boolean;
  results: PublishResult[];
}

export interface ScheduledRunSummary {
  /** Posts this run claimed and acted on. */
  processed: number;
  published: number;
  failed: number;
  outcomes: ScheduledPostOutcome[];
}

export interface PublishDuePostsOptions {
  /** Restrict the run to one user's queue. */
  userId?: string;
  /** Treat this instant as "now" (manual catch-up runs). */
  now?: Date;
  /** Maximum posts to process in this run. */
  limit?: number;
}

/**
 * Put back posts that were claimed but never finished: `publishing` rows whose
 * claim is older than the grace window.
 *
 * `publishedAt` doubles as the claim timestamp while a post is mid-flight, and
 * `finalize` overwrites it, so it only ever holds a claim time in that window.
 */
async function reclaimStrandedPosts(now: Date, userId?: string): Promise<void> {
  const cutoff = new Date(now.getTime() - CLAIM_GRACE_MS);
  const conditions = [
    eq(posts.status, "publishing"),
    isNotNull(posts.publishedAt),
    lte(posts.publishedAt, cutoff),
  ];
  if (userId) conditions.push(eq(posts.userId, userId));

  await db
    .update(posts)
    .set({ status: "scheduled", publishedAt: null })
    .where(and(...conditions));
}

/**
 * Write a post's terminal state.
 *
 * A post counts as published when at least one platform accepted it; `results`
 * keeps the per-platform detail, so a partial success stays visible in the UI
 * and is not retried — and duplicated — by the next run. A post where every
 * platform failed becomes `failed` and stops being retried automatically, so a
 * permanently failing post cannot loop forever.
 */
async function finalize(
  postId: string,
  ok: boolean,
  results: PublishResult[],
  now: Date
): Promise<void> {
  await db
    .update(posts)
    .set({
      status: ok ? "published" : "failed",
      results: JSON.stringify(results),
      publishedAt: ok ? now : null,
    })
    .where(eq(posts.id, postId));
}

/**
 * Publish every post that is due, oldest first.
 *
 * Safe to call concurrently: each post is claimed with a conditional update
 * before anything is sent to a platform, so overlapping runs cannot publish the
 * same post twice.
 */
export async function publishDuePosts(
  options: PublishDuePostsOptions = {}
): Promise<ScheduledRunSummary> {
  const { userId, now = new Date(), limit = DEFAULT_BATCH_LIMIT } = options;

  await reclaimStrandedPosts(now, userId);

  const conditions = [
    eq(posts.status, "scheduled"),
    isNotNull(posts.scheduledAt),
    lte(posts.scheduledAt, now),
  ];
  if (userId) conditions.push(eq(posts.userId, userId));

  const due = await db
    .select({
      id: posts.id,
      userId: posts.userId,
      content: posts.content,
      imageUrl: posts.imageUrl,
      platforms: posts.platforms,
    })
    .from(posts)
    .where(and(...conditions))
    .orderBy(asc(posts.scheduledAt))
    .limit(limit);

  const outcomes: ScheduledPostOutcome[] = [];

  for (const post of due) {
    /**
     * Claim the post before publishing. The update only matches while the row is
     * still `scheduled`, so if a cron run and a "Publish due now" click overlap,
     * the loser of the race gets no row back and skips the post rather than
     * publishing it a second time to a live audience.
     */
    const [claimed] = await db
      .update(posts)
      .set({ status: "publishing", publishedAt: now })
      .where(and(eq(posts.id, post.id), eq(posts.status, "scheduled")))
      .returning({ id: posts.id });

    if (!claimed) continue;

    const platforms = post.platforms
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    let results: PublishResult[];

    if (platforms.length === 0) {
      results = [
        {
          platform: "none",
          success: false,
          error: "Post has no target platforms",
        },
      ];
    } else {
      try {
        results = await publishToAllForUser(
          post.userId,
          post.content,
          post.imageUrl ?? undefined,
          platforms
        );
      } catch (e) {
        // A connector that throws must not abort the rest of the queue.
        results = [
          {
            platform: platforms.join(","),
            success: false,
            error: e instanceof Error && e.message ? e.message : "Publish failed",
          },
        ];
      }
    }

    const ok = results.some((r) => r.success);
    await finalize(post.id, ok, results, now);

    outcomes.push({ postId: post.id, userId: post.userId, ok, results });
  }

  return {
    processed: outcomes.length,
    published: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    outcomes,
  };
}