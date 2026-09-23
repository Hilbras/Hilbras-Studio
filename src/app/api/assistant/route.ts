import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/session";
import {
  resolveProvider,
  buildAssistantSystemPrompt,
  extractMemories,
  summarizeSegment,
} from "@/lib/ai";
import { streamChat as sdkStream, type ChatMessage } from "@/lib/ai-sdk";
import { consumeRateLimit } from "@/lib/rate-limit";
import {
  RECENT_CONTEXT,
  ensureSession,
  appendMessage,
  loadMessages,
  saveSummary,
  touchSession,
  recordMemories,
} from "@/lib/chat";

/**
 * Streaming chat for the Assistant.
 *
 * The client sends ONE new message plus the session id it minted optimistically;
 * history is read back from the database, so the context is authoritative
 * rather than whatever the client claims. Returns `text/plain` and writes tokens
 * as the active provider produces them (server actions can only reply once).
 *
 * While the reply streams: older turns are summarized once they age out of
 * RECENT_CONTEXT, and durable facts are extracted into long-term memory —
 * both awaited before the response closes so they survive the serverless tail.
 */

const bodySchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9-]+$/, "Invalid session id"),
  message: z.string().min(1, "Message is required").max(4000),
});

const encoder = new TextEncoder();

function errorJson(error: string, code: string, status: number) {
  return NextResponse.json({ error, code }, { status });
}

/** Only messages worth remembering trigger an extraction call. */
function worthExtracting(message: string): boolean {
  return message.trim().split(/\s+/).length >= 6;
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
  const { sessionId, message } = parsed.data;

  // Cost guard: a signed-in account must not be able to burn unlimited
  // provider spend. Counted before any model call; if the limiter itself
  // fails, fail open — a broken counter should never lock users out.
  const rateLimit = Math.max(
    1,
    Number.parseInt(process.env.ASSISTANT_RATE_LIMIT ?? "20", 10) || 20
  );
  try {
    const verdict = await consumeRateLimit(
      `assistant:${session.id}`,
      rateLimit,
      5 * 60
    );
    if (!verdict.allowed) {
      return new NextResponse(
        JSON.stringify({
          error: `You're sending messages too quickly — try again in ${
            verdict.retryAfterSec
          } second${verdict.retryAfterSec === 1 ? "" : "s"}.`,
          code: "RATE_LIMITED",
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(verdict.retryAfterSec),
          },
        }
      );
    }
  } catch (err) {
    // fail open (see above) — but never silently
    console.error("assistant rate limit check failed:", err);
  }

  // Resolve the model first: a missing provider must not persist a message
  // the assistant can never answer.
  const provider = await resolveProvider();
  if (!provider) {
    return errorJson(
      "No AI model configured. Add a provider in Settings → AI Provider.",
      "NO_MODEL",
      400
    );
  }

  const chat = await ensureSession(session.id, sessionId, message);
  if (!chat) return errorJson("Chat not found.", "FORBIDDEN", 403);

  await appendMessage(sessionId, "user", message);

  // ── Context: recent turns verbatim, older ones summarized ──
  const all = await loadMessages(sessionId);
  let summary = chat.summary ?? "";
  let summaryUpTo = chat.summaryUpTo ?? 0;

  const olderCount = Math.max(0, all.length - RECENT_CONTEXT);
  if (summaryUpTo < olderCount) {
    const segment = all.slice(summaryUpTo, olderCount);
    try {
      const add = await summarizeSegment(
        segment.map((m) => `${m.role}: ${m.content.slice(0, 500)}`).join("\n")
      );
      if (add) {
        // Oldest text falls off the front so the block stays bounded.
        summary = `${summary ? `${summary}\n\n` : ""}${add}`.slice(-4000);
        summaryUpTo = olderCount;
        await saveSummary(sessionId, summary, summaryUpTo);
      }
    } catch {
      // summarization is best-effort — fall back to a shorter window
    }
  }

  const system = await buildAssistantSystemPrompt({ summary });
  const recent = all.slice(-RECENT_CONTEXT).map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  // Extraction runs alongside the reply and is awaited before the stream
  // closes — work started after close can be killed serverless.
  const memoryTask = worthExtracting(message)
    ? extractMemories(message)
        .then((facts) => recordMemories(session.id, facts))
        .catch(() => undefined)
    : Promise.resolve();

  const history: ChatMessage[] = [{ role: "system", content: system }, ...recent];
  const generator = sdkStream(provider, history);

  // Pull the first token before replying: a dead key or bad base URL should
  // surface as a real HTTP error, not as a stream that dies immediately.
  let first: IteratorResult<string>;
  try {
    first = await generator.next();
  } catch (err) {
    const message_ = err instanceof Error ? err.message : "Provider request failed.";
    return errorJson(message_, "PROVIDER_ERROR", 502);
  }

  if (first.done || typeof first.value !== "string" || first.value.length === 0) {
    return errorJson("The model returned an empty response.", "EMPTY_RESPONSE", 502);
  }
  const firstChunk: string = first.value;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let full = firstChunk;
      let alive = true;
      const push = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          alive = false; // client navigated away
        }
      };

      push(firstChunk);
      try {
        while (alive) {
          const result = await generator.next();
          if (result.done) break;
          full += result.value;
          push(result.value);
        }
      } catch {
        // Status is already 200 — tell the user in-band instead of dropping it.
        push("\n\n⚠️ The response was interrupted — try again.");
      }

      try {
        await appendMessage(sessionId, "assistant", full.trim());
        await touchSession(sessionId);
        await memoryTask;
      } catch {
        // persistence failures must not break an already-delivered reply
      } finally {
        try {
          controller.close();
        } catch {
          // client already gone
        }
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
