import "server-only";

import {
  chatCompletion as sdkChat,
  streamChat as sdkStream,
  generatePost as sdkGenerate,
  type ChatMessage,
} from "@/lib/ai-sdk";
import { resolveProvider } from "@/lib/ai-provider-config";

/**
 * Chat wrappers over the resolved provider (remediation Task 17).
 *
 * Every wrapper resolves the active provider per request and refuses (with an
 * actionable error) when none is configured. `chatCompletion` and `streamChat`
 * speak in the Assistant's persona; `completeWithSystem` is the raw primitive
 * the Composer's rewrite tools build on.
 */

/** Persona for the Assistant's chat entry points. */
export const SYSTEM_PROMPT = `You are Hilbras Studio's AI social media assistant.
You help users create, adapt, and schedule content across social platforms.
Be concise, creative, and platform-aware.
When asked to create posts, adapt tone per platform rules.`;

const NO_PROVIDER = "No AI provider configured. Add one in Settings → AI Provider.";

/**
 * Chat with the AI — returns full response text.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  opts?: { model?: string }
): Promise<string> {
  const provider = await resolveProvider();
  if (!provider) throw new Error(NO_PROVIDER);

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
  if (!provider) throw new Error(NO_PROVIDER);

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
  if (!provider) throw new Error(NO_PROVIDER);

  return sdkGenerate(provider, prompt, platform);
}

/**
 * Single-shot completion with a caller-supplied system prompt.
 *
 * Used by the Composer's rewrite tools and the background memory/summary
 * calls: they must answer with the requested content only, never with the
 * Assistant's conversational persona.
 */
export async function completeWithSystem(system: string, user: string): Promise<string> {
  const provider = await resolveProvider();
  if (!provider) throw new Error(NO_PROVIDER);

  return sdkChat(provider, [
    { role: "system", content: system },
    { role: "user", content: user },
  ]);
}
