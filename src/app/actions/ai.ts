"use server";

import { chatCompletion, generatePost, completeWithSystem, type ChatMessage } from "@/lib/ai";
import { PLATFORM_REGISTRY, type PlatformId } from "@/lib/platforms";

export interface ChatResult {
  content: string;
  error?: string;
}

/**
 * The Composer is an editor, not a chat: every response must be usable content
 * (a post, a hashtag line) — never a conversational reply.
 */
const POST_SYSTEM = `You are the rewrite engine inside a social media post editor.
Rewrite or write posts. Output rules, strictly:
- Output ONLY the post text itself.
- No greetings, no preamble ("Sure!", "Here's…"), no explanations, no labels.
- No quotation marks wrapping the whole post, no markdown code fences.
- Keep the user's language, links, mentions and meaning; improve clarity, flow and impact.
- Respect the target platforms' character limits and content rules when given.
- Never invent facts, statistics or claims that are not in the text.`;

const HASHTAG_SYSTEM = `You generate hashtags for social media posts.
Output rules, strictly:
- Output ONLY the hashtags themselves.
- 5-8 hashtags, each starting with #, separated by spaces, on a single line.
- No numbering, no bullets, no backticks, no explanation, no labels.
- Match the post's topic and language.`;

/** Strip the wrappers a model adds despite instructions (fences, one quote pair). */
function sanitizePost(raw: string): string {
  let out = raw.trim();
  const fence = out.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  if (fence) out = fence[1].trim();
  const first = out.split("\n")[0]?.trim() ?? "";
  if (
    out.includes("\n") &&
    /^(sure|certainly|of course|here (is|'s)|below is|absolutely)\b/i.test(first)
  ) {
    out = out.split("\n").slice(1).join("\n").trim();
  }
  if (
    (out.startsWith('"') && out.endsWith('"') && out.length > 1) ||
    (out.startsWith("“") && out.endsWith("”") && out.length > 1)
  ) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

function sanitizeHashtags(raw: string): string {
  const tags = raw.match(/#[\p{L}\p{N}_]+/gu);
  if (!tags?.length) return raw.trim();
  return [...new Set(tags)].slice(0, 8).join(" ");
}

/** Platform limits the rewrite must respect, as a plain sentence. */
function platformContext(platforms: string[]): string {
  const specs = platforms
    .map((p) => PLATFORM_REGISTRY[p as PlatformId])
    .filter(Boolean);
  if (!specs.length) return "";
  const limits = specs
    .map(
      (s) =>
        `${s.name}${s.content.maxTextLength ? ` (max ${s.content.maxTextLength} characters)` : ""}`
    )
    .join(", ");
  return `Target platform(s): ${limits}.`;
}

/**
 * Improve the post in the editor — or write a fresh one when it's empty.
 * Returns post text only; on failure, `error` and empty `content`.
 */
export async function improvePostAction(
  text: string,
  platforms: string[] = []
): Promise<ChatResult> {
  try {
    const draft = text.trim();
    const context = platformContext(platforms);
    const user = draft
      ? `${context ? context + "\n" : ""}Improve this post. Return only the improved post:\n\n${draft}`
      : `${context ? context + "\n" : ""}Write a new social media post. Return only the post text.`;

    const content = await completeWithSystem(POST_SYSTEM, user);
    return { content: sanitizePost(content) };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { content: "", error: `AI service error: ${message}` };
  }
}

/** Hashtags for the current draft — returns a single `#a #b #c` line. */
export async function generateHashtagsAction(text: string): Promise<ChatResult> {
  const draft = text.trim();
  if (!draft) return { content: "", error: "Write a post first." };

  try {
    const content = await completeWithSystem(
      HASHTAG_SYSTEM,
      `Suggest hashtags for this post:\n\n${draft}`
    );
    return { content: sanitizeHashtags(content) };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { content: "", error: `AI service error: ${message}` };
  }
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
