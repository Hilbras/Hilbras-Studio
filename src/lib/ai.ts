import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db";
import { aiProviders } from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { decryptSecret } from "@/lib/crypto";
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
