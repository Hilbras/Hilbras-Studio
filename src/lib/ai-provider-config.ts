import "server-only";

import { eq, and, desc } from "drizzle-orm";

import { db } from "@/db";
import { aiProviders } from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { decryptSecret } from "@/lib/crypto";
import type { ProviderConfig } from "@/lib/ai-sdk";

/**
 * AI provider resolution (remediation Task 17).
 *
 * Loads the active provider from the DB (per-user) or falls back to the
 * built-in model from env vars. The chat wrappers in `ai-chat.ts` consume
 * this; the browser reaches configuration only through actions.
 */

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
  const openAiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  // Which key wins, and therefore which format the request must be shaped like.
  //
  // Derived from the key rather than from any other variable. This used to be
  // `HILBRAS_AI_BASE_URL || !legacyAnthropic ? "openai" : "anthropic"`, which
  // let the base URL outrank the key (AUD-018): a self-hoster with only
  // `ANTHROPIC_API_KEY` who also set a base URL — to reach a proxy, or just
  // following the docs — got an Anthropic key with `apiFormat: "openai"`. Every
  // Assistant request then failed, while every field an operator would plausibly
  // check looked correct.
  //
  // `HILBRAS_AI_API_KEY` is provider-neutral, so on its own there is nothing to
  // infer from and OpenAI is the documented default. `HILBRAS_AI_API_FORMAT` is
  // the way to say otherwise, and it is checked first because a person stating
  // their intent outranks a guess.
  const formatOverride = process.env.HILBRAS_AI_API_FORMAT;

  let apiFormat: ProviderConfig["apiFormat"];
  if (formatOverride === "anthropic" || formatOverride === "openai") {
    apiFormat = formatOverride;
  } else if (openAiKey) {
    apiFormat = "openai";
  } else if (anthropicKey) {
    apiFormat = "anthropic";
  } else {
    // Only `HILBRAS_AI_API_KEY` is set, and it says nothing about the provider.
    apiFormat = "openai";
  }

  const apiKey =
    process.env.HILBRAS_AI_API_KEY ?? openAiKey ?? anthropicKey;
  if (!apiKey) return null;

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

/** Which model the Assistant will answer with — safe to send to the client. */
export interface ActiveModelInfo {
  name: string;
  /** Empty for the built-in model — its real model id never reaches the UI. */
  modelId: string;
  configured: boolean;
}

export async function getActiveModelInfo(userId: string): Promise<ActiveModelInfo> {
  // 1. A provider the user explicitly selected
  const [active] = await db
    .select()
    .from(aiProviders)
    .where(and(eq(aiProviders.userId, userId), eq(aiProviders.isDefault, true)))
    .limit(1);
  if (active) {
    return { name: active.name, modelId: active.modelId, configured: true };
  }

  // 2. Built-in model — its name is shown, but not the model it runs
  const builtin = getBuiltinProviderConfig();
  if (builtin) {
    return { name: builtin.name, modelId: "", configured: true };
  }

  // 3. Built-in unavailable → most recent user provider (mirrors resolveForUser)
  const [anyRow] = await db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.userId, userId))
    .orderBy(desc(aiProviders.updatedAt))
    .limit(1);
  if (anyRow) {
    return { name: anyRow.name, modelId: anyRow.modelId, configured: true };
  }

  return { name: "No model", modelId: "—", configured: false };
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
