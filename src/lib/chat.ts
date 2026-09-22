import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { chatSessions, chatMessages, memories } from "@/db/schema";

/**
 * Assistant persistence: sessions, their messages, and long-term memory.
 *
 * The session id is minted client-side so the client can render optimistically
 * before the first token arrives; `ensureSession` owns the "does it exist and
 * is it yours" check, and a collision with someone else's id is rejected.
 */

/** Turns kept verbatim in the model's context; older ones get summarized. */
export const RECENT_CONTEXT = 24;
/** Hard cap on memories kept per user — oldest are evicted past it. */
export const MAX_MEMORIES = 30;
/** Cap when reopening a session so one row-set can't flood the client. */
const MAX_RELOAD_MESSAGES = 200;

export type SessionRow = typeof chatSessions.$inferSelect;
export type MessageRow = typeof chatMessages.$inferSelect;

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
  sessionId: string,
  role: "user" | "assistant",
  content: string
): Promise<void> {
  if (!content.trim()) return;
  await db.insert(chatMessages).values({
    id: randomUUID(),
    sessionId,
    role,
    content,
  });
  await touchSession(sessionId);
}

export async function touchSession(sessionId: string): Promise<void> {
  await db
    .update(chatSessions)
    .set({ updatedAt: new Date() })
    .where(eq(chatSessions.id, sessionId));
}

/** All turns of a session, oldest first. */
export async function loadMessages(sessionId: string): Promise<MessageRow[]> {
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(asc(chatMessages.createdAt))
    .limit(MAX_RELOAD_MESSAGES);
}

export async function saveSummary(
  sessionId: string,
  summary: string,
  summaryUpTo: number
): Promise<void> {
  await db
    .update(chatSessions)
    .set({ summary, summaryUpTo })
    .where(eq(chatSessions.id, sessionId));
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
