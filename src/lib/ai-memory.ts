import "server-only";

import { completeWithSystem } from "@/lib/ai-chat";
import { aiBudgetMessage, consumeAiBudget } from "@/lib/ai-budget";
import type { AiBudgetKind } from "@/lib/ai-limits";

/**
 * Background AI work: memory extraction and conversation summarization
 * (remediation Task 17). Both spend the server's key outside any user-facing
 * request, so both draw from the same budget ledger — a failed limiter fails
 * closed (consumeAiBudget throws, the caller's task fails).
 */

async function consumeBackgroundAiBudget(
  userId: string,
  kind: AiBudgetKind
): Promise<void> {
  const budget = await consumeAiBudget(userId, kind);
  if (!budget.allowed) throw new Error(aiBudgetMessage(budget));
}

const MEMORY_SYSTEM = `You extract durable facts from a single chat message and store them in the user's long-term memory.
A durable fact is about their brand, business, audience, products, voice, workflow, or an explicit preference — something that will still be true next week.
Output strictly:
- One fact per line, as a plain third-person statement ("The user's brand voice is casual and playful.").
- No numbering, no bullets, no quotes, no commentary.
- If the message contains nothing durable, output exactly: NONE`;

/** Pull durable facts out of a user message — `[]` when there are none. */
export async function extractMemories(
  message: string,
  userId: string
): Promise<string[]> {
  await consumeBackgroundAiBudget(userId, "memory");
  const raw = await completeWithSystem(MEMORY_SYSTEM, message.slice(0, 4000));
  const lines = raw
    .split("\n")
    .map((l) => l.replace(/^[-*•]\s*|^\d+[.)]\s*/, "").trim())
    .filter((l) => l.length > 3 && !/^none\.?$/i.test(l))
    .slice(0, 5);
  return lines;
}

const SUMMARY_SYSTEM = `You summarize a segment of an ongoing chat so the conversation can continue without the earlier turns.
Cover: facts about the user, decisions made, drafts written, and open threads.
Output ONLY the summary, at most 180 words, no preamble or labels.`;

/** Compress old turns into text that can stand in for them in context. */
export async function summarizeSegment(
  segment: string,
  userId: string
): Promise<string> {
  await consumeBackgroundAiBudget(userId, "summary");
  const raw = await completeWithSystem(SUMMARY_SYSTEM, segment.slice(0, 12000));
  return raw.trim();
}
