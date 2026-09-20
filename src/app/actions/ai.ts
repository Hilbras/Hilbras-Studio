"use server";

import { chatCompletion, generatePost, type ChatMessage } from "@/lib/ai";

export interface ChatResult {
  content: string;
  error?: string;
}

/**
 * Process a user message through the AI assistant.
 * Returns accumulated text for the full response.
 */
export async function processAssistantMessage(
  messages: ChatMessage[],
  userMessage: string
): Promise<ChatResult> {
  try {
    const response = await chatCompletion([
      ...messages,
      { role: "user", content: userMessage },
    ]);
    return { content: response };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { content: "", error: `AI service error: ${message}` };
  }
}

/**
 * Generate a post draft with optional platform targeting.
 */
export async function generatePostAction(
  prompt: string,
  platform?: string
): Promise<{ content: string; error?: string }> {
  try {
    const content = await generatePost(prompt, platform);
    return { content };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { content: "", error: `Generation failed: ${message}` };
  }
}
