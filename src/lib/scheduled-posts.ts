import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, lte, or } from "drizzle-orm";

import { db } from "@/db";
import { posts } from "@/db/schema";
import { publishToAllForUser, type PublishResult } from "@/lib/publish";
import { log } from "@/lib/logger";
import { getPostTargets } from "@/lib/posts/targets";

/**
 * Scheduled-post runner.
 *
 * The Composer saves queued posts with `status = "scheduled"` and a
 * `scheduled_at` timestamp, but nothing in a serverless deployment publishes them
 * on its own: Vercel functions only run in response to a request, so a due post
 * would otherwise sit in the queue forever. This module turns due posts into
 * published ones, and is driven from two places:
 *
 *   1. `GET /api/cron/publish-scheduled` — Vercel Cron, every user's queue,
 *      authenticated by the server-only cron secret
 *   2. `publishDuePostsAction` — the Scheduler's "Publish due now" button, scoped
 *      to the signed-in user (the way to publish on time on Vercel's Hobby plan,
 *      where cron jobs may only run once a day)
 *
 * ## Claim / lease model
 *
 * Every post a run acts on carries a claim:
 *
 *   - `claim_id` — the attempt token (a UUID per claim). Only the run holding
 *     it may finalize the post, so a stale invocation that wakes up after its
 *     lease was recovered cannot overwrite a newer terminal state.
 *   - `claim_expires_at` — the lease deadline. While it is in the future the
 *     claim is valid and no other run may take the post; once it passes, the
 *     claiming invocation is presumed dead and the recovery step below acts.
 *   - `dispatch_started_at` — set immediately before platform calls begin.
 *     This is what makes an expired claim's outcome *uncertain*: the post may
 *     already be live, so it is marked `failed` with an explicit
 *     "verify before retrying" result rather than being blindly re-queued and
 *     published a second time.
 *
 * Two time budgets bound each invocation so it dies gracefully before the
 * platform kills it: a per-post provider timeout and a whole-run deadline,
 * both below the route's `maxDuration`.
 */

/**
 * Posts considered per run. Publishing waits on Meta's media containers (30s
 * image / 60s video each), so the run deadline below — not this number — is
 * what actually bounds a run; this just caps how many rows are examined.
 */
const DEFAULT_BATCH_LIMIT = 10;

/**
 * Provider budget for a single post. Long enough for a Threads/Meta video
 * container (up to ~60s). A post that exceeds it has an *uncertain* outcome:
 * the platform may have accepted it, so it is failed with an explicit
 * "verify before retrying" result and never retried automatically.
 */
const DEFAULT_POST_TIMEOUT_MS = 60_000;

/**
 * Whole-run budget. The cron/manual route exports `maxDuration = 120`; this
 * keeps ~20s of headroom for token refresh, claim recovery and response work,
 * so the run stops itself before Vercel terminates the function.
 */
const DEFAULT_RUN_DEADLINE_MS = 100_000;

/**
 * How long a claim stays valid. Comfortably longer than the run deadline, so a
 * live run can never lose its own claim; when a run is killed outright its
 * claims expire after this window and recovery can act on them.
 */
const CLAIM_LEASE_MS = 5 * 60 * 1000;

/** Reason recorded for a post whose provider calls started but never resolved. */
const UNCERTAIN_OUTCOME_ERROR =
  "Publishing outcome unknown — the run or provider call expired before " +
  "results came back. The post may already be live. Check the platform " +
  "before retrying.";

function uncertainOutcomeResults(): PublishResult[] {
  return [{ platform: "unknown", success: false, error: UNCERTAIN_OUTCOME_ERROR }];
}

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
  /** Maximum posts to examine in this run. */
  limit?: number;
  /** Whole-run time budget in ms. */
  runDeadlineMs?: number;
  /** Per-post provider time budget in ms. */
  postTimeoutMs?: number;
}

/**
 * Recover claims from runs that died mid-flight. Two strictly disjoint cases:
 *
 *   1. Lease expired **before** dispatch began — nothing was sent to a
 *      platform, so re-queuing is safe and the post is put back to
 *      `scheduled`.
 *   2. Lease expired **after** dispatch began, or a legacy row from before the
 *      lease columns existed — the outcome is uncertain, so the post becomes
 *      `failed` with an explicit unknown-outcome result. It is never retried
 *      automatically: a blind retry is how a crashed run duplicates a live
 *      post.
 *
 * Claims whose lease is still valid are untouched — a long-running (but alive)
 * invocation keeps ownership until `claim_expires_at` passes.
 */
async function recoverExpiredClaims(now: Date, userId?: string): Promise<void> {
  const requeueConditions = [
    eq(posts.status, "publishing"),
    isNotNull(posts.claimExpiresAt),
    lte(posts.claimExpiresAt, now),
    isNull(posts.dispatchStartedAt),
  ];
  if (userId) requeueConditions.push(eq(posts.userId, userId));

  await db
    .update(posts)
    .set({
      status: "scheduled",
      claimId: null,
      claimExpiresAt: null,
      publishedAt: null,
    })
    .where(and(...requeueConditions));

  const legacyCutoff = new Date(now.getTime() - CLAIM_LEASE_MS);
  const uncertainConditions = [
    eq(posts.status, "publishing"),
    or(
      and(
        isNotNull(posts.claimExpiresAt),
        lte(posts.claimExpiresAt, now),
        isNotNull(posts.dispatchStartedAt)
      ),
      and(
        isNull(posts.claimExpiresAt),
        isNotNull(posts.publishedAt),
        lte(posts.publishedAt, legacyCutoff)
      )
    ),
  ];
  if (userId) uncertainConditions.push(eq(posts.userId, userId));

  await db
    .update(posts)
    .set({
      status: "failed",
      results: JSON.stringify(uncertainOutcomeResults()),
      claimId: null,
      claimExpiresAt: null,
      dispatchStartedAt: null,
      publishedAt: null,
    })
    .where(and(...uncertainConditions));
}

/**
 * Write a post's terminal state — conditional on still owning the claim.
 *
 * A post counts as published when at least one platform accepted it; `results`
 * keeps the per-platform detail, so a partial success stays visible in the UI
 * and is not retried — and duplicated — by the next run. A post where every
 * platform failed becomes `failed` and stops being retried automatically, so a
 * permanently failing post cannot loop forever.
 *
 * The `claim_id` guard means only the run that claimed the post may finalize
 * it: if the lease expired and another run recovered (or re-claimed) the row,
 * this update matches nothing and the newer state wins. Returns whether the
 * row was actually finalized.
 */
async function finalize(
  postId: string,
  claimId: string,
  ok: boolean,
  results: PublishResult[],
  now: Date
): Promise<boolean> {
  const [row] = await db
    .update(posts)
    .set({
      status: ok ? "published" : "failed",
      results: JSON.stringify(results),
      publishedAt: ok ? now : null,
      claimId: null,
      claimExpiresAt: null,
      dispatchStartedAt: null,
    })
    .where(
      and(
        eq(posts.id, postId),
        eq(posts.status, "publishing"),
        eq(posts.claimId, claimId)
      )
    )
    .returning({ id: posts.id });

  return Boolean(row);
}

type RaceOutcome<T> = { timedOut: true } | { timedOut: false; value: T };

/**
 * Await `work` with a deadline. On timeout the underlying promise is detached
 * (it cannot be cancelled) and its eventual result — or rejection — is
 * discarded, so a slow provider call can neither block the run nor surface as
 * an unhandled rejection.
 */
async function raceTimeout<T>(
  work: Promise<T>,
  ms: number
): Promise<RaceOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RaceOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });

  try {
    const outcome = await Promise.race([
      work.then((value): RaceOutcome<T> => ({ timedOut: false, value })),
      timeout,
    ]);
    if (outcome.timedOut) {
      // We lost the race: swallow whatever the abandoned call does later.
      work.catch(() => undefined);
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Publish every post that is due, oldest first.
 *
 * Safe to call concurrently: each post is claimed with a conditional update
 * (guarded by status *and* ownership at finalization) before anything is sent
 * to a platform, so overlapping cron runs and "Publish due now" clicks cannot
 * publish the same post twice — and a run that outlives its own claim cannot
 * overwrite a newer result.
 *
 * The run stops claiming new posts once the remaining budget is smaller than a
 * full per-post timeout, so it returns (and the function is reaped) before the
 * serverless deadline; posts it did not get to simply stay `scheduled`.
 */
export async function publishDuePosts(
  options: PublishDuePostsOptions = {}
): Promise<ScheduledRunSummary> {
  const {
    userId,
    now = new Date(),
    limit = DEFAULT_BATCH_LIMIT,
    runDeadlineMs = DEFAULT_RUN_DEADLINE_MS,
    postTimeoutMs = DEFAULT_POST_TIMEOUT_MS,
  } = options;

  const startedAt = Date.now();

  await recoverExpiredClaims(now, userId);

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
    })
    .from(posts)
    .where(and(...conditions))
    .orderBy(asc(posts.scheduledAt))
    .limit(limit);

  // One query for every due post rather than one per post inside the loop.
  const targets = await getPostTargets(due.map((p) => p.id));

  const outcomes: ScheduledPostOutcome[] = [];

  for (const post of due) {
    // Stop before the platform deadline: only claim a post when a full
    // per-post budget still fits inside the run's remaining time.
    if (Date.now() - startedAt + postTimeoutMs > runDeadlineMs) break;

    /**
     * Claim the post before publishing. The update only matches while the row
     * is still `scheduled`, so if a cron run and a "Publish due now" click
     * overlap, the loser of the race gets no row back and skips the post
     * rather than publishing it a second time to a live audience. The fresh
     * `claim_id` makes this run the owner; `claim_expires_at` keeps other runs
     * out for the duration of the lease.
     */
    const claimId = randomUUID();
    const [claimed] = await db
      .update(posts)
      .set({
        status: "publishing",
        claimId,
        claimExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
        dispatchStartedAt: null,
        publishedAt: null,
      })
      .where(and(eq(posts.id, post.id), eq(posts.status, "scheduled")))
      .returning({ id: posts.id });

    if (!claimed) continue;

    // `post_targets` is the only record of where a post goes (ADR-006). A post
    // with no target rows cannot be published, and `createPost` writes both in
    // one transaction — so this is unreachable through the app, and is kept only
    // to fail a row that predates the join table with a legible reason.
    const platforms = targets.get(post.id) ?? [];

    if (platforms.length === 0) {
      const noTargets: PublishResult[] = [
        {
          platform: "none",
          success: false,
          error: "Post has no target platforms",
        },
      ];
      await finalize(post.id, claimId, false, noTargets, now);
      outcomes.push({ postId: post.id, userId: post.userId, ok: false, results: noTargets });
      continue;
    }

    // From here on the outcome of any interruption is uncertain: record that
    // dispatch began *before* the first platform call, still under our claim.
    await db
      .update(posts)
      .set({ dispatchStartedAt: new Date() })
      .where(and(eq(posts.id, post.id), eq(posts.claimId, claimId)));

    /**
     * A connector that throws must not abort the rest of the queue, and a
     * connector that hangs must not eat the whole run: `raceTimeout` bounds
     * the wait and the catch turns a rejection into a normal failed result.
     */
    const work = publishToAllForUser(
      post.userId,
      post.content,
      post.imageUrl ?? undefined,
      platforms
    ).catch(
      (e): PublishResult[] => [
        {
          platform: platforms.join(","),
          success: false,
          error: e instanceof Error && e.message ? e.message : "Publish failed",
        },
      ]
    );

    const raced = await raceTimeout(work, postTimeoutMs);

    let results: PublishResult[];
    let ok: boolean;

    if (raced.timedOut) {
      // The provider call may still land after we give up. Record the
      // uncertainty instead of a fabricated success or failure, and do not
      // retry — the post may already be live.
      results = uncertainOutcomeResults();
      ok = false;
    } else {
      results = raced.value;
      ok = results.some((r) => r.success);
    }

    await finalize(post.id, claimId, ok, results, now);

    outcomes.push({ postId: post.id, userId: post.userId, ok, results });
  }

  const published = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.length - published;
  log.info("publish_run_finished", { processed: outcomes.length, published, failed });

  return {
    processed: outcomes.length,
    published,
    failed,
    outcomes,
  };
}
