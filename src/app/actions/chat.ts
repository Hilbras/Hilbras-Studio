"use server";

import { z } from "zod";

import { getSessionUser } from "@/lib/session";
import {
  listSessions,
  getSessionOwned,
  deleteSession,
  renameSession,
  listMemories,
  deleteMemory,
  clearMemories,
  loadMessages,
  type ChatSessionItem,
  type ChatMessageItem,
  type MemoryItem,
} from "@/lib/chat";

/** Ids are client-minted: session ids are UUIDs, memory ids are UUIDs too — bounded either way. */
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id");
const renameInput = z.object({
  id: idSchema,
  title: z
    .string()
    .trim()
    .min(1, "Title cannot be empty")
    .max(80),
});

// The DTOs describe rows in `@/lib/chat`, so they are declared there and
// re-exported here. A `"use server"` module may only export async functions, so
// declaring a shape here puts a contract in a module whose contract does not
// describe shapes (remediation Task 17).
export type { ChatSessionItem, ChatMessageItem, MemoryItem };

/** Recent sessions for the Assistant's session picker. */
export async function listChatSessions(): Promise<ChatSessionItem[]> {
  const session = await getSessionUser();
  if (!session) return [];

  const rows = await listSessions(session.id);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** One session's full transcript, for reopening it. */
export async function loadChatSession(
  id: string
): Promise<{ title: string; messages: ChatMessageItem[] } | null> {
  const session = await getSessionUser();
  if (!session) return null;

  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return null;

  const row = await getSessionOwned(session.id, parsed.data);
  if (!row) return null;

  const messages = await loadMessages(session.id, parsed.data);
  return {
    title: row.title,
    messages: messages.map((m) => ({ id: m.id, role: m.role, content: m.content })),
  };
}

export async function renameChatSession(
  id: string,
  title: string
): Promise<{ ok: boolean; error?: string }> {
  const session = await getSessionUser();
  if (!session) return { ok: false, error: "Not signed in" };

  const parsed = renameInput.safeParse({ id, title });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  // Collapse whatever whitespace the caller sent, then bound it again.
  const clean = parsed.data.title.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!clean) return { ok: false, error: "Title cannot be empty" };

  const owned = await getSessionOwned(session.id, parsed.data.id);
  if (!owned) return { ok: false, error: "Chat not found" };

  await renameSession(session.id, parsed.data.id, clean);
  return { ok: true };
}

export async function deleteChatSession(id: string): Promise<{ ok: boolean }> {
  const session = await getSessionUser();
  if (!session) return { ok: false };

  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { ok: false };

  await deleteSession(session.id, parsed.data);
  return { ok: true };
}

/* ── Long-term memory ───────────────────────────────────────── */

export async function listAssistantMemories(): Promise<MemoryItem[]> {
  const session = await getSessionUser();
  if (!session) return [];

  const rows = await listMemories(session.id);
  return rows.map((m) => ({
    id: m.id,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
  }));
}

export async function deleteAssistantMemory(id: string): Promise<{ ok: boolean }> {
  const session = await getSessionUser();
  if (!session) return { ok: false };

  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { ok: false };

  await deleteMemory(session.id, parsed.data);
  return { ok: true };
}

export async function clearAssistantMemories(): Promise<{ ok: boolean }> {
  const session = await getSessionUser();
  if (!session) return { ok: false };

  await clearMemories(session.id);
  return { ok: true };
}
