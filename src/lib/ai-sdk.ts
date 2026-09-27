/**
 * Hilbras AI SDK — lightweight, provider-agnostic HTTP client.
 *
 * Supports any OpenAI-compatible or Anthropic-compatible API
 * without vendor-specific dependencies.
 */

import { fetchPinnedProvider } from "@/lib/pinned-provider-fetch";
import {
  AI_DEFAULT_MAX_OUTPUT_TOKENS,
  AI_MAX_OUTPUT_CHARS,
  assertAiInputSize,
  assertAiOutputSize,
} from "@/lib/ai-limits";

export type ApiFormat = "openai" | "anthropic";

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  apiFormat: ApiFormat;
  modelId: string;
}

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Single-line, length-capped rendering of an upstream error body. Response
 * fragments are genuinely useful when debugging a pasted base URL, so they
 * stay — but control characters are stripped and the body never exceeds
 * 120 characters.
 */
export function formatProviderHttpError(status: number, body: string): string {
  const clean = body
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return clean ? `HTTP ${status}: ${clean}` : `HTTP ${status}`;
}

/* ── OpenAI format ──────────────────────────────────────────── */

async function openaiChatCompletion(
  config: ProviderConfig,
  messages: ChatMessage[],
  opts?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  const url = stripTrailingSlash(config.baseUrl) + "/chat/completions";

  assertAiInputSize(messages);

  const body: Record<string, unknown> = {
    model: config.modelId,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: opts?.maxTokens ?? AI_DEFAULT_MAX_OUTPUT_TOKENS,
  };
  if (opts?.temperature !== undefined) body.temperature = opts.temperature;

  const providerRequest = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  };
  const res = await fetchPinnedProvider(url, providerRequest);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(formatProviderHttpError(res.status, text));
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  assertAiOutputSize(content);
  return content;
}

async function* openaiStreamChat(
  config: ProviderConfig,
  messages: ChatMessage[],
  opts?: { maxTokens?: number; temperature?: number }
): AsyncGenerator<string> {
  const url = stripTrailingSlash(config.baseUrl) + "/chat/completions";

  assertAiInputSize(messages);

  const body: Record<string, unknown> = {
    model: config.modelId,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
    max_tokens: opts?.maxTokens ?? AI_DEFAULT_MAX_OUTPUT_TOKENS,
  };
  if (opts?.temperature !== undefined) body.temperature = opts.temperature;

  const providerRequest = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  };
  const res = await fetchPinnedProvider(url, providerRequest);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(formatProviderHttpError(res.status, text));
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;

      try {
        const parsed = JSON.parse(data) as {
          choices?: { delta?: { content?: string } }[];
        };
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {
        // skip malformed chunks
      }
    }
  }
}

/* ── Anthropic format ───────────────────────────────────────── */

async function anthropicChatCompletion(
  config: ProviderConfig,
  messages: ChatMessage[],
  opts?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  const url = stripTrailingSlash(config.baseUrl) + "/messages";

  assertAiInputSize(messages);

  // Separate system message from conversation messages
  const systemMsg = messages.find((m) => m.role === "system");
  const convMsgs: AnthropicMessage[] = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const body: Record<string, unknown> = {
    model: config.modelId,
    max_tokens: opts?.maxTokens ?? AI_DEFAULT_MAX_OUTPUT_TOKENS,
    messages: convMsgs,
  };
  if (systemMsg) body.system = systemMsg.content;
  if (opts?.temperature !== undefined) body.temperature = opts.temperature;

  const providerRequest = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  };
  const res = await fetchPinnedProvider(url, providerRequest);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(formatProviderHttpError(res.status, text));
  }

  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
  };
  const content = data.content?.[0]?.text ?? "";
  assertAiOutputSize(content);
  return content;
}

async function* anthropicStreamChat(
  config: ProviderConfig,
  messages: ChatMessage[],
  opts?: { maxTokens?: number; temperature?: number }
): AsyncGenerator<string> {
  const url = stripTrailingSlash(config.baseUrl) + "/messages";

  assertAiInputSize(messages);

  const systemMsg = messages.find((m) => m.role === "system");
  const convMsgs: AnthropicMessage[] = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const body: Record<string, unknown> = {
    model: config.modelId,
    max_tokens: opts?.maxTokens ?? AI_DEFAULT_MAX_OUTPUT_TOKENS,
    messages: convMsgs,
    stream: true,
  };
  if (systemMsg) body.system = systemMsg.content;
  if (opts?.temperature !== undefined) body.temperature = opts.temperature;

  const providerRequest = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  };
  const res = await fetchPinnedProvider(url, providerRequest);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(formatProviderHttpError(res.status, text));
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);

      try {
        const parsed = JSON.parse(data) as {
          type?: string;
          delta?: { type?: string; text?: string };
        };
        if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
          if (parsed.delta.text) yield parsed.delta.text;
        }
      } catch {
        // skip malformed chunks
      }
    }
  }
}

async function* capStreamOutput(
  stream: AsyncGenerator<string>,
): AsyncGenerator<string> {
  let chars = 0;
  for await (const chunk of stream) {
    chars += chunk.length;
    if (chars > AI_MAX_OUTPUT_CHARS) {
      throw new Error(
        `AI response exceeded the maximum length of ${AI_MAX_OUTPUT_CHARS} characters`,
      );
    }
    yield chunk;
  }
}

/* ── Public API ─────────────────────────────────────────────── */

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Send a chat completion request. Dispatches to the correct API format.
 */
export async function chatCompletion(
  config: ProviderConfig,
  messages: ChatMessage[],
  opts?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  if (config.apiFormat === "anthropic") {
    return anthropicChatCompletion(config, messages, opts);
  }
  return openaiChatCompletion(config, messages, opts);
}

/**
 * Streaming chat completion. Yields text chunks as they arrive.
 */
export async function* streamChat(
  config: ProviderConfig,
  messages: ChatMessage[],
  opts?: { maxTokens?: number; temperature?: number }
): AsyncGenerator<string> {
  if (config.apiFormat === "anthropic") {
    yield* capStreamOutput(anthropicStreamChat(config, messages, opts));
    return;
  }
  yield* capStreamOutput(openaiStreamChat(config, messages, opts));
}

/**
 * Quick post generation helper.
 */
export async function generatePost(
  config: ProviderConfig,
  prompt: string,
  platform?: string
): Promise<string> {
  const systemPrompt = `You are Hilbras Studio's AI social media assistant.
You help users create, adapt, and schedule content across social platforms.
Be concise, creative, and platform-aware.
When asked to create posts, adapt tone per platform rules.`;

  const platformContext = platform
    ? `Target platform: ${platform}. Adapt tone, length, and format accordingly.`
    : "";

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Create a social media post: "${prompt}" ${platformContext}` },
  ];

  return chatCompletion(config, messages);
}
