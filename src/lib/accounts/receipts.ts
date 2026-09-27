/**
 * Publish receipts — the idempotency cache for side-effecting capabilities
 * (ADR-005).
 *
 * A connector asks `findReceipt` before dispatching and calls `recordReceipt`
 * after. Two calls, so a connector that crashes between them behaves the way an
 * unrecorded dispatch does: the outcome is unknown and the step fails rather
 * than retrying. That asymmetry is deliberate — the dangerous direction is
 * *claiming* a receipt for something that never shipped.
 *
 * Server-only: the receipt key is derived from a run id and must not be
 * forgeable from the browser.
 */

import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { publishReceipts } from "@/db/schema";

export interface Receipt {
  platformPostId?: string;
  permalink?: string;
  accountKey: string;
  platform: string;
}

/** A prior dispatch for this key, or null if the step has never succeeded. */
export async function findReceipt(
  userId: string,
  idempotencyKey: string,
): Promise<Receipt | null> {
  const [row] = await db
    .select()
    .from(publishReceipts)
    .where(
      and(
        eq(publishReceipts.userId, userId),
        eq(publishReceipts.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);

  if (!row) return null;
  return {
    accountKey: row.accountKey,
    platform: row.platform,
    platformPostId: row.platformPostId ?? undefined,
    permalink: row.permalink ?? undefined,
  };
}

/**
 * Record a dispatch.
 *
 * Returns `false` if a receipt already existed, which means a concurrent
 * duplicate won the race and this dispatch was redundant. The caller should
 * report the existing receipt rather than the one it just made.
 */
export async function recordReceipt(input: {
  userId: string;
  idempotencyKey: string;
  accountKey: string;
  platform: string;
  platformPostId?: string;
  permalink?: string;
}): Promise<boolean> {
  const inserted = await db
    .insert(publishReceipts)
    .values({
      idempotencyKey: input.idempotencyKey,
      userId: input.userId,
      accountKey: input.accountKey,
      platform: input.platform,
      platformPostId: input.platformPostId ?? null,
      permalink: input.permalink ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: publishReceipts.idempotencyKey });

  return inserted.length > 0;
}
