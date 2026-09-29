"use server";

import { z } from "zod";

import {
  assistantCompletion,
  generateHashtags,
  improvePost,
  generatePostDraft,
  type ChatResult,
} from "@/lib/ai/composer";
import type { ChatMessage } from "@/lib/ai";
import { getSessionUser } from "@/lib/session";

export type { ChatResult };

/**
 * Thin adapters (remediation Task 17): session gate and input validation only.
 * The prompts, sanitizers, and spend control live in the server-only
 * `@/lib/ai/composer` — every action here spends real provider tokens on the
 * server's key, so an unauthenticated caller must never reach the model.
 */

const textInput = z.object({ text: z.string().max(10000, "Post is too long") });

const postInput = z.object({
  text: z.string().max(10000, "Post is too long"),
  platforms: z.array(z.string().max(30)).max(10),
});

const assistantInput = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().max(40000),
      })
    )
    .max(100),
  userMessage: z.string().min(1, "Message is required").max(4000),
});

const generateInput = z.object({
  prompt: z.string().max(4000),
  platform: z.string().max(30).optional(),
});

/** Improve the post in the editor — or write a fresh one when it's empty. */
export async function improvePostAction(
  text: string,
  platforms: string[] = []
): Promise<ChatResult> {
  const session = await getSessionUser();
  if (!session) return { content: "", error: "Not signed in." };

  const parsed = postInput.safeParse({ text, platforms });
  if (!parsed.success) {
    return { content: "", error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  return improvePost(session.id, parsed.data.text, parsed.data.platforms);
}

/** Hashtags for the current draft — returns a single `#a #b #c` line. */
export async function generateHashtagsAction(text: string): Promise<ChatResult> {
  const session = await getSessionUser();
  if (!session) return { content: "", error: "Not signed in." };

  const parsed = textInput.safeParse({ text });
  if (!parsed.success) {
    return { content: "", error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  return generateHashtags(session.id, parsed.data.text);
}

/** Process a user message through the AI assistant. */
export async function processAssistantMessage(
  messages: ChatMessage[],
  userMessage: string
): Promise<ChatResult> {
  const session = await getSessionUser();
  if (!session) return { content: "", error: "Not signed in." };

  const parsed = assistantInput.safeParse({ messages, userMessage });
  if (!parsed.success) {
    return { content: "", error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  return assistantCompletion(session.id, parsed.data.messages, parsed.data.userMessage);
}

/** Generate a post draft with optional platform targeting. */
export async function generatePostAction(
  prompt: string,
  platform?: string
): Promise<ChatResult> {
  const session = await getSessionUser();
  if (!session) return { content: "", error: "Not signed in." };

  const parsed = generateInput.safeParse({ prompt, platform });
  if (!parsed.success) {
    return { content: "", error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  return generatePostDraft(session.id, parsed.data.prompt, parsed.data.platform);
}
