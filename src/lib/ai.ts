import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db";
import { aiProviders } from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { decryptSecret } from "@/lib/crypto";
import { listMemories } from "@/lib/chat";
import { PLATFORM_REGISTRY, type PlatformId } from "@/lib/platforms";
import {
  getDashboardStats,
  getRecentActivity,
  getWeeklyChartData,
  getConnectedAccountsWithDetails,
} from "@/app/actions/dashboard";
import {
  chatCompletion as sdkChat,
  streamChat as sdkStream,
  generatePost as sdkGenerate,
  type ProviderConfig,
  type ChatMessage,
} from "@/lib/ai-sdk";

/**
 * Hilbras AI Service
 *
 * Loads provider config from the DB (per-user) or falls back to env vars.
 * Uses the lightweight ai-sdk — no vendor SDK dependencies.
 */

export type { ChatMessage } from "@/lib/ai-sdk";

const SYSTEM_PROMPT = `You are Hilbras Studio's AI social media assistant.
You help users create, adapt, and schedule content across social platforms.
Be concise, creative, and platform-aware.
When asked to create posts, adapt tone per platform rules.`;

/* ── Built-in default model ─────────────────────────────────── */

/**
 * Stable id of the built-in "Hilbras AI" model.
 * Not a DB row — it always exists, and users can neither edit nor remove it.
 * It is active whenever no user-added provider is selected.
 */
export const BUILTIN_PROVIDER_ID = "builtin";

/**
 * Config for the built-in model. Server-side only: the key lives in env vars
 * and is never sent to the client.
 *
 * `HILBRAS_AI_*` wins; otherwise it falls back to the legacy
 * `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` pair.
 * Returns null when the server has no key configured.
 */
export function getBuiltinProviderConfig(): ProviderConfig | null {
  const legacyAnthropic =
    !!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY;

  const apiKey =
    process.env.HILBRAS_AI_API_KEY ??
    process.env.OPENAI_API_KEY ??
    process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const formatOverride = process.env.HILBRAS_AI_API_FORMAT;
  const apiFormat: ProviderConfig["apiFormat"] =
    formatOverride === "anthropic" || formatOverride === "openai"
      ? formatOverride
      : process.env.HILBRAS_AI_BASE_URL || !legacyAnthropic
        ? "openai"
        : "anthropic";

  const baseUrl =
    process.env.HILBRAS_AI_BASE_URL ??
    (apiFormat === "anthropic"
      ? "https://api.anthropic.com/v1"
      : "https://api.openai.com/v1");

  const modelId =
    process.env.HILBRAS_AI_MODEL_ID ??
    (apiFormat === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o-mini");

  return { name: "Hilbras AI", baseUrl, apiKey, apiFormat, modelId };
}

/* ── Provider resolution ────────────────────────────────────── */

function rowToConfig(row: {
  name: string;
  baseUrl: string;
  apiKeyEnc: string;
  apiFormat: string;
  modelId: string;
}): ProviderConfig {
  return {
    name: row.name,
    baseUrl: row.baseUrl,
    apiKey: decryptSecret(row.apiKeyEnc),
    apiFormat: row.apiFormat as ProviderConfig["apiFormat"],
    modelId: row.modelId,
  };
}

/**
 * Resolve the active AI provider for a user.
 *
 * Active selection lives on `ai_providers.is_default`:
 * - a row is default  → that provider is active;
 * - no row is default → the built-in model is active (the initial state).
 *
 * Falls back further when the built-in model has no server key.
 */
async function resolveForUser(userId: string): Promise<ProviderConfig | null> {
  // 1. A provider the user explicitly selected
  const [active] = await db
    .select()
    .from(aiProviders)
    .where(and(eq(aiProviders.userId, userId), eq(aiProviders.isDefault, true)))
    .limit(1);
  if (active) return rowToConfig(active);

  // 2. Built-in default model
  const builtin = getBuiltinProviderConfig();
  if (builtin) return builtin;

  // 3. Built-in unavailable → any provider the user added
  const [anyRow] = await db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.userId, userId))
    .orderBy(desc(aiProviders.updatedAt))
    .limit(1);
  if (anyRow) return rowToConfig(anyRow);

  return null;
}

/** Resolve the active provider for the current session. */
export async function resolveProvider(): Promise<ProviderConfig | null> {
  const user = await getSessionUser();
  if (!user) return null;
  return resolveForUser(user.id);
}

/**
 * Resolve provider without session (for server actions that pass context).
 */
export async function resolveProviderForUser(userId: string): Promise<ProviderConfig | null> {
  return resolveForUser(userId);
}

/* ── Assistant context ──────────────────────────────────────── */

/** Display name for a platform id: "threads" → "Threads". */
function platformName(id: string): string {
  return (
    PLATFORM_REGISTRY[id as PlatformId]?.name ??
    id.charAt(0).toUpperCase() + id.slice(1)
  );
}

/**
 * System prompt for the Assistant: durable memory, real account data and an
 * optional rolling summary of the conversation's older turns.
 *
 * Every block is best-effort — if a query fails, the prompt is returned
 * without it rather than breaking the chat. Call from an authenticated request.
 */
export async function buildAssistantSystemPrompt(opts?: { summary?: string }): Promise<string> {
  const RULES = `

Rules:
- A <memory> block may follow: durable facts about this user. Treat them as true and stay consistent with them.
- A <user_context> block may follow with this user's real account data — use it when it helps.
- A <conversation_summary> block may follow: earlier turns of this conversation, already remembered for you.
- Never invent metrics, follower counts, engagement numbers, or dates that are not given.
- If something is not tracked (impressions, likes, comments), say so plainly instead of guessing.
- For connection or configuration issues, point the user to the right page (Accounts, Composer, Scheduler, Settings).`;

  const blocks: string[] = [];

  // Long-term memory — facts from every session, not just this one.
  try {
    const user = await getSessionUser();
    if (user) {
      const rows = await listMemories(user.id);
      const facts = rows.map((m) => `- ${m.content}`);
      if (facts.length) blocks.push(`<memory>\n${facts.join("\n")}\n</memory>`);
    }
  } catch {
    // best-effort
  }

  try {
    const [accounts, stats, weekly, activity] = await Promise.all([
      getConnectedAccountsWithDetails(),
      getDashboardStats(),
      getWeeklyChartData(),
      getRecentActivity(3),
    ]);

    const stat = (label: string) => stats.find((s) => s.label === label)?.value ?? 0;
    const lines: string[] = [
      `Today: ${new Date().toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      })}`,
      `Connected accounts: ${
        accounts.length
          ? accounts
              .map((a) => `${platformName(a.platform)} @${a.username ?? "unknown"}`)
              .join(", ")
          : "none connected yet"
      }`,
      `Posts: ${stat("Posts Published")} published in the last 7 days, ${stat(
        "Scheduled"
      )} scheduled, ${stat("Total Posts")} total`,
      `This week (published per day): ${weekly.map((w) => `${w.day} ${w.posts}`).join(" · ")}`,
    ];
    if (activity.length) {
      lines.push(
        `Recent activity: ${activity
          .map((a) => `${a.action} — ${a.detail} (${a.timestamp})`)
          .join("; ")}`
      );
    }
    blocks.push(`<user_context>\n${lines.join("\n")}\n</user_context>`);
  } catch {
    // best-effort — the chat must not fail because context queries did
  }

  const summary = opts?.summary?.trim();
  if (summary) blocks.push(`<conversation_summary>\n${summary}\n</conversation_summary>`);

  const body = blocks.length ? `\n\n${blocks.join("\n\n")}` : "";
  return `${SYSTEM_PROMPT}${body}${RULES}`;
}

/* ── Memory extraction / summarization ──────────────────────── */

const MEMORY_SYSTEM = `You extract durable facts from a single chat message and store them in the user's long-term memory.
A durable fact is about their brand, business, audience, products, voice, workflow, or an explicit preference — something that will still be true next week.
Output strictly:
- One fact per line, as a plain third-person statement ("The user's brand voice is casual and playful.").
- No numbering, no bullets, no quotes, no commentary.
- If the message contains nothing durable, output exactly: NONE`;

/** Pull durable facts out of a user message — `[]` when there are none. */
export async function extractMemories(message: string): Promise<string[]> {
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
export async function summarizeSegment(segment: string): Promise<string> {
  const raw = await completeWithSystem(SUMMARY_SYSTEM, segment.slice(0, 12000));
  return raw.trim();
}

/** Which model the Assistant will answer with — safe to send to the client. */
export interface ActiveModelInfo {
  name: string;
  modelId: string;
  configured: boolean;
  /** The hidden server-managed model — keep its name out of the UI. */
  isBuiltin: boolean;
}

export async function getActiveModelInfo(userId: string): Promise<ActiveModelInfo> {
  // 1. A provider the user explicitly selected
  const [active] = await db
    .select()
    .from(aiProviders)
    .where(and(eq(aiProviders.userId, userId), eq(aiProviders.isDefault, true)))
    .limit(1);
  if (active) {
    return { name: active.name, modelId: active.modelId, configured: true, isBuiltin: false };
  }

  // 2. Nothing selected → hidden server fallback (when configured)
  const builtin = getBuiltinProviderConfig();
  if (builtin) {
    return { name: builtin.name, modelId: builtin.modelId, configured: true, isBuiltin: true };
  }

  // 3. Fallback unavailable → most recent user provider (mirrors resolveForUser)
  const [anyRow] = await db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.userId, userId))
    .orderBy(desc(aiProviders.updatedAt))
    .limit(1);
  if (anyRow) {
    return { name: anyRow.name, modelId: anyRow.modelId, configured: true, isBuiltin: false };
  }

  return { name: "No model", modelId: "—", configured: false, isBuiltin: false };
}

/* ── Public API ─────────────────────────────────────────────── */

/**
 * Chat with the AI — returns full response text.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  opts?: { model?: string }
): Promise<string> {
  const provider = await resolveProvider();
  if (!provider) throw new Error("No AI provider configured. Add one in Settings → AI Provider.");

  const fullMessages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages,
  ];

  return sdkChat(provider, fullMessages);
}

/**
 * Streaming chat — yields chunks as they arrive.
 */
export async function* streamChat(
  messages: ChatMessage[],
  opts?: { model?: string }
): AsyncGenerator<string> {
  const provider = await resolveProvider();
  if (!provider) throw new Error("No AI provider configured. Add one in Settings → AI Provider.");

  const fullMessages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages,
  ];

  yield* sdkStream(provider, fullMessages);
}

/**
 * Generate a short post based on a prompt and target platform.
 */
export async function generatePost(prompt: string, platform?: string): Promise<string> {
  const provider = await resolveProvider();
  if (!provider) throw new Error("No AI provider configured. Add one in Settings → AI Provider.");

  return sdkGenerate(provider, prompt, platform);
}

/**
 * Single-shot completion with a caller-supplied system prompt.
 *
 * Used by the Composer's rewrite tools: they must answer with content only,
 * never with the Assistant's conversational persona.
 */
export async function completeWithSystem(system: string, user: string): Promise<string> {
  const provider = await resolveProvider();
  if (!provider) throw new Error("No AI provider configured. Add one in Settings → AI Provider.");

  return sdkChat(provider, [
    { role: "system", content: system },
    { role: "user", content: user },
  ]);
}

/**
 * Get available models from configured providers.
 */
export function getAvailableModels(): { id: string; name: string; provider: string }[] {
  return [
    { id: "gpt-4o", name: "GPT-4o (Latest)", provider: "openai" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini (Fast)", provider: "openai" },
    { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" },
    { id: "claude-haiku-4-20250414", name: "Claude Haiku 4", provider: "anthropic" },
  ];
}

/**
 * Check which providers have credentials configured.
 */
export async function getProviderStatus(): Promise<{ openai: boolean; anthropic: boolean }> {
  return {
    openai: !!process.env.OPENAI_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
  };
}
