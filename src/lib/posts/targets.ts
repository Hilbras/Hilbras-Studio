/**
 * Post targets — which platforms (and which accounts) a post goes to.
 *
 * Replaces `posts.platforms`, a comma-separated string. The string could not
 * express a per-account target and could not be joined, so a post aimed at two
 * of a user's four X accounts had no way to say so. The column is dropped in
 * migration 0011; this table is the only place that knows where a post goes.
 *
 * Kept in one module so the read and the write cannot drift — a post written
 * here is always readable here, and there is exactly one place that knows the
 * table exists.
 *
 * ## Why the write takes a transaction
 *
 * A post row and its target rows are one fact, not two. Written separately, a
 * crash between the two inserts leaves a post that exists, is schedulable, and
 * has nowhere to go — and the scheduler's only symptom is "Post has no target
 * platforms" at publish time, hours later, for a post the user never saw fail.
 * So `setPostTargets` refuses to run outside a transaction and the post service
 * owns the boundary.
 */

import "server-only";

import { asc, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { postTargets, type PostTarget } from "@/db/schema";

/**
 * The transaction handle `db.transaction()` hands its callback.
 *
 * Derived rather than hand-written: a structural type of the whole transaction
 * object would drift from Drizzle's generics on upgrade, and re-declaring the
 * table union here is exactly the kind of thing that compiles until the day it
 * silently accepts the wrong table.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A post, as the Composer's and Scheduler's lists render it.
 *
 * Declared here rather than in `@/app/actions/posts` because it is a *row plus
 * its targets*, and this is the only module that knows how those two are joined
 * — `posts.platforms` is gone (migration 0011), so a post's platforms cannot be
 * read without asking this module for them. A `"use server"` module may only
 * export async functions, so a shape declared there is a contract in a module
 * whose contract does not describe shapes (remediation Task 17).
 *
 * Every date is a pre-formatted ISO string rather than a `Date`. A `Date` that
 * crossed the client boundary would arrive in the browser's zone, so the same
 * row would render as a different moment depending on who was looking; an ISO
 * string is unambiguous and the screen formats it where it is displayed.
 */
export interface PostItem {
  id: string;
  content: string;
  imageUrl: string | null;
  /**
   * Target platform ids, from `post_targets`.
   *
   * An array, not a comma-separated string: the old shape could not be counted,
   * indexed, or joined, which is why every consumer carried its own `split(",")`.
   */
  platforms: string[];
  status: string;
  scheduledAt: string | null;
  results: string | null;
  createdAt: string;
  publishedAt: string | null;
}

/** Trim, drop empties, and de-duplicate while preserving first-seen order. */
function normalize(platforms: readonly string[]): string[] {
  return [...new Set(platforms.map((p) => p.trim()).filter(Boolean))];
}

/**
 * Replace a post's targets.
 *
 * True replace semantics: whatever was there is removed first, so calling this
 * twice with the same input is indistinguishable from calling it once. That is
 * the property the callers below depend on — the Composer's "edit platforms"
 * path and the backfill both re-run this against rows that already have targets.
 *
 * The delete-then-insert is not redundant with the table's unique constraint.
 * The constraint is the last line of defence against a *concurrent* writer; this
 * ordering is what makes a legitimate re-write produce one row per platform
 * instead of relying on a conflict to swallow the duplicate.
 */
export async function setPostTargets(
  tx: Tx,
  postId: string,
  platforms: readonly string[],
): Promise<void> {
  await tx.delete(postTargets).where(eq(postTargets.postId, postId));

  const unique = normalize(platforms);
  if (!unique.length) return;

  await tx
    .insert(postTargets)
    .values(unique.map((platform) => ({ postId, platform, accountKey: null })));
}

/**
 * Targets for several posts, in one query.
 *
 * Bulk by design: the list, analytics, and scheduler views read up to 50 posts
 * at a time, and a per-post lookup would be 50 round trips. Keyed by post id,
 * with posts that have no targets simply absent from the map.
 */
export async function getPostTargets(
  postIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byPost = new Map<string, string[]>();
  if (!postIds.length) return byPost;

  const rows = await db
    .select({ postId: postTargets.postId, platform: postTargets.platform })
    .from(postTargets)
    .where(inArray(postTargets.postId, [...postIds]))
    .orderBy(asc(postTargets.platform));

  for (const row of rows) {
    const list = byPost.get(row.postId) ?? [];
    list.push(row.platform);
    byPost.set(row.postId, list);
  }
  return byPost;
}

/** Targets for one post, as a plain array. */
export async function getPostTargetList(postId: string): Promise<string[]> {
  const rows = await db
    .select({ platform: postTargets.platform })
    .from(postTargets)
    .where(eq(postTargets.postId, postId))
    .orderBy(asc(postTargets.platform));
  return rows.map((r) => r.platform);
}

export type { PostTarget };
