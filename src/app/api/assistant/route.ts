import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/session";
import { resolveProvider, buildAssistantSystemPrompt } from "@/lib/ai";
import { streamChat as sdkStream, type ChatMessage } from "@/lib/ai-sdk";

/**
 * Streaming chat for the Assistant.
 *
 * Returns `text/plain` and writes tokens as the active provider produces them
 * (server actions can only reply once, so the Assistant uses this route).
 * Pre-stream failures come back as JSON with a `code` the client can act on —
 * `NO_MODEL` means nothing is configured and links the user to Settings.
 */

const MAX_HISTORY = 40;
const MAX_MESSAGE_CHARS = 8000;

const bodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.string().min(1).max(MAX_MESSAGE_CHARS),
      })
    )
    .min(1)
    .max(MAX_HISTORY),
});

const encoder = new TextEncoder();

function errorJson(error: string, code: string, status: number) {
  return NextResponse.json({ error, code }, { status });
}

export async function POST(req: NextRequest) {
  const session = await getSessionUser();
  if (!session) return errorJson("Not signed in.", "UNAUTHENTICATED", 401);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorJson("Invalid request body.", "BAD_REQUEST", 400);
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return errorJson(
      parsed.error.issues[0]?.message ?? "Invalid request body.",
      "BAD_REQUEST",
      400
    );
  }

  // The user's active model: built-in default or a selected provider.
  const provider = await resolveProvider();
  if (!provider) {
    return errorJson(
      "No AI model configured. Add a provider in Settings → AI Provider.",
      "NO_MODEL",
      400
    );
  }

  const system = await buildAssistantSystemPrompt();
  const history: ChatMessage[] = [
    { role: "system", content: system },
    ...parsed.data.messages,
  ];

  const generator = sdkStream(provider, history);

  // Pull the first token before replying: a dead key or bad base URL should
  // surface as a real HTTP error, not as a stream that dies immediately.
  let first: IteratorResult<string>;
  try {
    first = await generator.next();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Provider request failed.";
    return errorJson(message, "PROVIDER_ERROR", 502);
  }

  if (first.done || typeof first.value !== "string" || first.value.length === 0) {
    return errorJson("The model returned an empty response.", "EMPTY_RESPONSE", 502);
  }
  const firstChunk: string = first.value;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(firstChunk));
      try {
        for (;;) {
          const result = await generator.next();
          if (result.done) break;
          controller.enqueue(encoder.encode(result.value));
        }
      } catch {
        // Status is already 200 — tell the user in-band instead of dropping it.
        controller.enqueue(encoder.encode("\n\n⚠️ The response was interrupted — try again."));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
