"use server";

import { z } from "zod";

import { chatCompletion, generatePost, completeWithSystem, type ChatMessage } from "@/lib/ai";
import { PLATFORM_REGISTRY, type PlatformId } from "@/lib/platforms";
import { getSessionUser } from "@/lib/session";

export interface ChatResult {
  content: string;
  error?: string;
}

/**
 * Every action in here spends real provider tokens on the server's key, so
 * each one starts with the same session gate — an unauthenticated caller
 * must never reach the model.
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
  const session = await getSessionUser();
  if (!session) return { content: "", error: "Not signed in." };

  const parsed = postInput.safeParse({ text, platforms });
  if (!parsed.success) {
    return { content: "", error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const draft = parsed.data.text.trim();
    const context = platformContext(parsed.data.platforms);
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
  const session = await getSessionUser();
  if (!session) return { content: "", error: "Not signed in." };

  const parsed = textInput.safeParse({ text });
  if (!parsed.success) {
    return { content: "", error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const draft = parsed.data.text.trim();
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
  const session = await getSessionUser();
  if (!session) return { content: "", error: "Not signed in." };

  const parsed = assistantInput.safeParse({ messages, userMessage });
  if (!parsed.success) {
    return { content: "", error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const response = await chatCompletion([
      ...parsed.data.messages,
      { role: "user", content: parsed.data.userMessage },
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
  const session = await getSessionUser();
  if (!session) return { content: "", error: "Not signed in." };

  const parsed = generateInput.safeParse({ prompt, platform });
  if (!parsed.success) {
    return { content: "", error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const content = await generatePost(parsed.data.prompt, parsed.data.platform);
    return { content };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { content: "", error: `Generation failed: ${message}` };
  }
}
