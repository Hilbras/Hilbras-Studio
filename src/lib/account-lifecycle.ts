import "server-only";

import { eq, inArray, like } from "drizzle-orm";

import { db } from "@/db";
import {
  accounts,
  aiProviders,
  chatMessages,
  chatSessions,
  connections,
  executionPolicies,
  goals,
  inboxReadState,
  mediaAssets,
  memories,
  postTargets,
  posts,
  publishReceipts,
  rateLimits,
  runEvents,
  runStepApprovals,
  runSteps,
  runs,
  storedCredentials,
  userPreferences,
  users,
} from "@/db/schema";

/**
 * Tenant data boundary for account export and deletion (remediation Task 8).
 *
 * Every table the user's id reaches is enumerated here — the same set the
 * schema's `onDelete: "cascade"` rules cover, plus `rate_limits`, which keys
 * its rows by an opaque string embedding the user id and therefore has no
 * foreign key to cascade for it.
 *
 * The export never contains secret material. Encrypted blobs are useless to
 * the user without the server's key, and plaintext secrets have no place in a
 * downloadable file — so the fields below are stripped and exported as
 * presence flags instead.
 */

const SECRET_COLUMNS = ["passwordHash", "apiKeyEnc", "accessTokenEnc", "refreshTokenEnc", "encryptedValue"] as const;

/** Drop secret-bearing columns from a row, recording that they existed. */
function stripSecrets<T extends Record<string, unknown>>(
  row: T
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if ((SECRET_COLUMNS as readonly string[]).includes(key)) {
      clean[key.replace(/Enc$/, "") + "Present"] = true;
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

/**
 * Assemble the full export for one user.
 *
 * Rows are read per table so the shape doubles as the documented data
 * inventory: what the product stores, per section, is what this returns.
 */
export async function exportUserData(userId: string): Promise<Record<string, unknown>> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return {};

  const [preferencesRows, credentialRows, postRows, providerRows, mediaRows, chatSessionRows, memoryRows, goalRows, runRows, policyRows, receiptRows, readStateRows, connectionRows, accountRows] =
    await Promise.all([
      db.select().from(userPreferences).where(eq(userPreferences.userId, userId)),
      db.select().from(storedCredentials).where(eq(storedCredentials.userId, userId)),
      db.select().from(posts).where(eq(posts.userId, userId)),
      db.select().from(aiProviders).where(eq(aiProviders.userId, userId)),
      db.select().from(mediaAssets).where(eq(mediaAssets.userId, userId)),
      db.select().from(chatSessions).where(eq(chatSessions.userId, userId)),
      db.select().from(memories).where(eq(memories.userId, userId)),
      db.select().from(goals).where(eq(goals.userId, userId)),
      db.select().from(runs).where(eq(runs.userId, userId)),
      db.select().from(executionPolicies).where(eq(executionPolicies.userId, userId)),
      db.select().from(publishReceipts).where(eq(publishReceipts.userId, userId)),
      db.select().from(inboxReadState).where(eq(inboxReadState.userId, userId)),
      db.select().from(connections).where(eq(connections.userId, userId)),
      db.select().from(accounts).where(eq(accounts.userId, userId)),
    ]);

  // Child tables key through their parent, not by user id.
  const postIds = postRows.map((p) => p.id);
  const runIds = runRows.map((r) => r.id);
  const sessionIds = chatSessionRows.map((s) => s.id);

  const [targetRows, stepRows, eventRows, approvalRows, messageRows] = await Promise.all([
    postIds.length
      ? db.select().from(postTargets).where(inArray(postTargets.postId, postIds))
      : Promise.resolve([]),
    runIds.length
      ? db.select().from(runSteps).where(inArray(runSteps.runId, runIds))
      : Promise.resolve([]),
    runIds.length
      ? db.select().from(runEvents).where(inArray(runEvents.runId, runIds))
      : Promise.resolve([]),
    runIds.length
      ? db.select().from(runStepApprovals).where(inArray(runStepApprovals.runId, runIds))
      : Promise.resolve([]),
    sessionIds.length
      ? db.select().from(chatMessages).where(inArray(chatMessages.sessionId, sessionIds))
      : Promise.resolve([]),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    format: "hilbras-studio-export/v1",
    profile: stripSecrets(user),
    preferences: preferencesRows,
    storedCredentials: credentialRows.map(stripSecrets),
    posts: postRows.map(stripSecrets),
    postTargets: targetRows,
    mediaAssets: mediaRows,
    aiProviders: providerRows.map(stripSecrets),
    connections: connectionRows.map(stripSecrets),
    accounts: accountRows,
    goals: goalRows,
    runs: runRows,
    runSteps: stepRows,
    runEvents: eventRows,
    runStepApprovals: approvalRows.map(stripSecrets),
    executionPolicies: policyRows,
    publishReceipts: receiptRows,
    inboxReadState: readStateRows,
    chats: chatSessionRows,
    chatMessages: messageRows,
    memories: memoryRows,
    // rate_limits holds transient request counters keyed like
    // `assistant:<user id>` — operational state, not user data; deletion
    // removes them, the export does not include them.
    rateLimits: "excluded (transient counters)",
  };
}

export interface DeleteAccountResult {
  /** Rows removed from `rate_limits` — the only non-cascading table. */
  rateLimitRowsRemoved: number;
}

/**
 * Delete the account and everything its id reaches.
 *
 * One transaction: the `rate_limits` rows (keyed by an opaque string embedding
 * the user id, so no cascade reaches them) go first, then the user row —
 * whose `onDelete: "cascade"` rules remove every table enumerated above.
 * Returns so the caller can report; the session cookie is the caller's job.
 *
 * Two-tenant safety comes from the same scoping everywhere else in the app:
 * every statement below filters by this user's id (or a key containing it —
 * ids are UUIDs, which contain no SQL LIKE wildcards), so another tenant's
 * rows are unreachable by construction. Verified by integration tests.
 */
export async function deleteAccount(userId: string): Promise<DeleteAccountResult> {
  return db.transaction(async (tx) => {
    // Ids are UUIDs (hex + hyphens), so the key pattern contains no SQL LIKE
    // wildcards and matches exactly the rows minted for this user.
    const removed = await tx
      .delete(rateLimits)
      .where(like(rateLimits.key, `%${userId}%`))
      .returning({ key: rateLimits.key });

    await tx.delete(users).where(eq(users.id, userId));

    return { rateLimitRowsRemoved: removed.length };
  });
}
