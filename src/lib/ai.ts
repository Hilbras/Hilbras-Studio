import { eq, desc } from "drizzle-orm";
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

/* ── Provider resolution ────────────────────────────────────── */

/**
 * Resolve the active AI provider for the current user.
 * Priority: DB default provider → first DB provider → env fallback.
 */
export async function resolveProvider(): Promise<ProviderConfig | null> {
  const user = await getSessionUser();
  if (!user) return null;

  // 1. Try the user's default provider
  const [defaultRow] = await db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.userId, user.id))
    .orderBy(desc(aiProviders.isDefault), desc(aiProviders.updatedAt))
    .limit(1);

  if (defaultRow) {
    const apiKey = decryptSecret(defaultRow.apiKeyEnc);
    return {
      name: defaultRow.name,
      baseUrl: defaultRow.baseUrl,
      apiKey,
      apiFormat: defaultRow.apiFormat as ProviderConfig["apiFormat"],
      modelId: defaultRow.modelId,
    };
  }

  // 2. Env fallback
  const envKey = process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!envKey) return null;

  const isAnthropic = !!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY;
  return {
    name: isAnthropic ? "Anthropic (env)" : "OpenAI (env)",
    baseUrl: isAnthropic
      ? "https://api.anthropic.com/v1"
      : "https://api.openai.com/v1",
    apiKey: envKey,
    apiFormat: isAnthropic ? "anthropic" : "openai",
    modelId: isAnthropic ? "claude-sonnet-4-20250514" : "gpt-4o-mini",
  };
}

/**
 * Resolve provider without session (for server actions that pass context).
 */
export async function resolveProviderForUser(userId: string): Promise<ProviderConfig | null> {
  const [defaultRow] = await db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.userId, userId))
    .orderBy(desc(aiProviders.isDefault), desc(aiProviders.updatedAt))
    .limit(1);

  if (defaultRow) {
    const apiKey = decryptSecret(defaultRow.apiKeyEnc);
    return {
      name: defaultRow.name,
      baseUrl: defaultRow.baseUrl,
      apiKey,
      apiFormat: defaultRow.apiFormat as ProviderConfig["apiFormat"],
      modelId: defaultRow.modelId,
    };
  }

  const envKey = process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!envKey) return null;

  const isAnthropic = !!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY;
  return {
    name: isAnthropic ? "Anthropic (env)" : "OpenAI (env)",
    baseUrl: isAnthropic
      ? "https://api.anthropic.com/v1"
      : "https://api.openai.com/v1",
    apiKey: envKey,
    apiFormat: isAnthropic ? "anthropic" : "openai",
    modelId: isAnthropic ? "claude-sonnet-4-20250514" : "gpt-4o-mini",
  };
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
