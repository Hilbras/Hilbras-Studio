import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { chatSessions, chatMessages, memories } from "@/db/schema";

/**
 * Assistant persistence: sessions, their messages, and long-term memory.
 *
 * The session id is minted client-side so the client can render optimistically
 * before the first token arrives; `ensureSession` mints or fetches a session and
 * rejects a collision with someone else's id.
 *
 * **Every function below also takes `userId` and puts it in its own `WHERE`
 * clause.** `ensureSession` used to be the only thing standing between one user's
 * session id and another user's messages, which made the guarantee a property of
 * every call site rather than of this module — and call sites are exactly what
 * gets written by someone who has not read this comment. This is the same rule
 * ADR-008 set for the Runtime read layer, applied here for the same reason. The
 * two checks are not redundant: `ensureSession` decides whether a *new* session
 * may be minted for this user, and these decide whether an *existing* row is
 * this user's to read or write.
 */

/** Turns kept verbatim in the model's context; older ones get summarized. */
export const RECENT_CONTEXT = 24;
/** Hard cap on memories kept per user — oldest are evicted past it. */
export const MAX_MEMORIES = 30;
/** Cap when reopening a session so one row-set can't flood the client. */
const MAX_RELOAD_MESSAGES = 200;

export type SessionRow = typeof chatSessions.$inferSelect;
export type MessageRow = typeof chatMessages.$inferSelect;

// ---------------------------------------------------------------------------
// Shapes the browser renders
// ---------------------------------------------------------------------------
//
// These live here, with the data they describe, rather than in the
// `@/app/actions/chat` adapter that returns them. A `"use server"` module may
// only export async functions — every export is compiled into an RPC endpoint
// the client can call — so a DTO declared there is a declaration in a module
// whose contract does not describe DTOs, and the shape a client component
// depends on is owned by the transport layer rather than by the data.
//
// They are re-exported from the action module, so no consumer's import changed
// shape. (remediation Task 17)

/** One Assistant session, as the session picker lists it. */
export interface ChatSessionItem {
  id: string;
  title: string;
  updatedAt: string;
}

/** One stored turn, as a reopened transcript renders it. */
export interface ChatMessageItem {
  id: string;
  role: string;
  content: string;
}

/** One durable fact the Assistant remembers about this user. */
export interface MemoryItem {
  id: string;
  content: string;
  createdAt: string;
}

function titleFrom(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

/**
 * Load the session or create it as this user's (titled from the first message).
 * Returns null when the id exists but belongs to someone else.
 */
export async function ensureSession(
  userId: string,
  sessionId: string,
  firstMessage: string
): Promise<SessionRow | null> {
  const [existing] = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId))
    .limit(1);

  if (existing) return existing.userId === userId ? existing : null;

  const [created] = await db
    .insert(chatSessions)
    .values({ id: sessionId, userId, title: titleFrom(firstMessage) })
    .returning();
  return created;
}

export async function appendMessage(
  userId: string,
  sessionId: string,
  role: "user" | "assistant",
  content: string
): Promise<void> {
  if (!content.trim()) return;
  // Checked here rather than trusted from the caller, because the alternative is
  // that the only thing stopping a write into another user's transcript is
  // someone remembering to check. Throws rather than returning quietly: a
  // missing row here means a session id that is not this user's, and silently
  // dropping the user's message would look like a bug in the assistant.
  await assertOwnedSession(userId, sessionId);
  await db.insert(chatMessages).values({
    id: randomUUID(),
    sessionId,
    role,
    content,
  });
  await touchSession(userId, sessionId);
}

export async function touchSession(
  userId: string,
  sessionId: string
): Promise<void> {
  await db
    .update(chatSessions)
    .set({ updatedAt: new Date() })
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)));
}

/**
 * All turns of a session, oldest first.
 *
 * Scoped by joining to the session's owner rather than filtering messages
 * directly, because `chat_messages` has no `user_id` of its own — the owner
 * lives one join away, and that join is the authorization.
 */
export async function loadMessages(
  userId: string,
  sessionId: string
): Promise<MessageRow[]> {
  return db
    .select({ row: chatMessages })
    .from(chatMessages)
    .innerJoin(chatSessions, eq(chatMessages.sessionId, chatSessions.id))
    .where(and(eq(chatMessages.sessionId, sessionId), eq(chatSessions.userId, userId)))
    .orderBy(asc(chatMessages.createdAt))
    .limit(MAX_RELOAD_MESSAGES)
    .then((rows) => rows.map((r) => r.row));
}

export async function saveSummary(
  userId: string,
  sessionId: string,
  summary: string,
  summaryUpTo: number
): Promise<void> {
  await db
    .update(chatSessions)
    .set({ summary, summaryUpTo })
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)));
}

/** The session, if it exists and belongs to `userId`. */
async function assertOwnedSession(userId: string, sessionId: string): Promise<void> {
  const [row] = await db
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
    .limit(1);
  if (!row) throw new Error(`Chat session ${sessionId} is not available`);
}

/* ── Sessions (user-facing) ─────────────────────────────────── */

export async function listSessions(userId: string, limit = 20) {
  return db
    .select({
      id: chatSessions.id,
      title: chatSessions.title,
      updatedAt: chatSessions.updatedAt,
    })
    .from(chatSessions)
    .where(eq(chatSessions.userId, userId))
    .orderBy(desc(chatSessions.updatedAt))
    .limit(limit);
}

export async function getSessionOwned(
  userId: string,
  sessionId: string
): Promise<SessionRow | null> {
  const [row] = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function deleteSession(userId: string, sessionId: string): Promise<void> {
  await db
    .delete(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)));
}

export async function renameSession(
  userId: string,
  sessionId: string,
  title: string
): Promise<void> {
  await db
    .update(chatSessions)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)));
}

/* ── Memories ───────────────────────────────────────────────── */

export async function listMemories(userId: string) {
  return db
    .select({
      id: memories.id,
      content: memories.content,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .where(eq(memories.userId, userId))
    .orderBy(desc(memories.createdAt));
}

/**
 * Insert new facts, skipping ones already known (case-insensitive) and
 * evicting the oldest rows past MAX_MEMORIES.
 */
export async function recordMemories(userId: string, facts: string[]): Promise<void> {
  const cleaned = facts
    .map((f) => f.trim())
    .filter((f) => f.length > 3 && f.length < 300);
  if (!cleaned.length) return;

  const existing = await db
    .select({ content: memories.content })
    .from(memories)
    .where(eq(memories.userId, userId));

  const known = new Set(existing.map((r) => r.content.toLowerCase()));
  const fresh = cleaned.filter((f) => !known.has(f.toLowerCase()));
  if (!fresh.length) return;

  await db.insert(memories).values(
    fresh.map((content) => ({ id: randomUUID(), userId, content }))
  );

  // Evict oldest beyond the cap.
  const all = await db
    .select({ id: memories.id })
    .from(memories)
    .where(eq(memories.userId, userId))
    .orderBy(asc(memories.createdAt));
  if (all.length > MAX_MEMORIES) {
    const evict = all.slice(0, all.length - MAX_MEMORIES).map((r) => r.id);
    await db.delete(memories).where(inArray(memories.id, evict));
  }
}

export async function deleteMemory(userId: string, memoryId: string): Promise<void> {
  await db
    .delete(memories)
    .where(and(eq(memories.id, memoryId), eq(memories.userId, userId)));
}

export async function clearMemories(userId: string): Promise<void> {
  await db.delete(memories).where(eq(memories.userId, userId));
}
