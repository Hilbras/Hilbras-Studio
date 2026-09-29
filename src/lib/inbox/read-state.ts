import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, lt } from "drizzle-orm";

import { db } from "@/db";
import { inboxReadState } from "@/db/schema";

/**
 * Read state for the live-fetched inbox (remediation Task 14).
 *
 * Provider messages exist only inside provider API responses — there is no
 * inbox table — so "seen" is stored per platform message id and consulted when
 * the mentions/DMs render. Every write prunes entries past the window, so the
 * table stays proportional to recent activity instead of growing forever.
 */

/** How long a read marker is kept. Providers paginate recent items only, so 30 days covers anything that can still surface. */
const READ_STATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** The ids among `keys` (`platform:messageId`) the user has already read. */
export async function readMessageKeys(
  userId: string,
  keys: string[]
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();

  // Split by platform: the query is per platform, matching the unique index.
  const byPlatform = new Map<string, string[]>();
  for (const key of keys) {
    const [platform, messageId] = key.split(":");
    if (!platform || !messageId) continue;
    byPlatform.set(platform, [...(byPlatform.get(platform) ?? []), messageId]);
  }

  const read = new Set<string>();
  const cutoff = new Date(Date.now() - READ_STATE_WINDOW_MS);

  await Promise.all(
    [...byPlatform.entries()].map(async ([platform, messageIds]) => {
      const rows = await db
        .select({ messageId: inboxReadState.messageId })
        .from(inboxReadState)
        .where(
          and(
            eq(inboxReadState.userId, userId),
            eq(inboxReadState.platform, platform),
            inArray(inboxReadState.messageId, messageIds),
            // A marker past the window is about to be pruned; treat it as read
            // on the way out either way.
            gt(inboxReadState.readAt, cutoff),
          ),
        );
      for (const row of rows) read.add(`${platform}:${row.messageId}`);
    }),
  );

  return read;
}

/** Mark one message read. Idempotent; the unique constraint absorbs re-reads. */
export async function markMessageRead(
  userId: string,
  platform: string,
  messageId: string
): Promise<void> {
  await db
    .insert(inboxReadState)
    .values({
      id: randomUUID(),
      userId,
      platform,
      messageId,
      readAt: new Date(),
    })
    .onConflictDoNothing();

  // Prune the user's window on every write — one statement, keeps the table
  // proportional to activity without a dedicated sweeper.
  await db
    .delete(inboxReadState)
    .where(
      and(
        eq(inboxReadState.userId, userId),
        lt(inboxReadState.readAt, new Date(Date.now() - READ_STATE_WINDOW_MS)),
      ),
    );
}
