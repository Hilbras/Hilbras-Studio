/**
 * The `compose_post` tool — writing the text a plan will publish.
 *
 * ## Why this is a tool and not the planner's job
 *
 * The planner produces a *plan*, and the plan says where the copy comes from.
 * If the planner also wrote the copy, the post would be fixed at planning
 * time: a goal firing every morning would publish the same words every morning,
 * because the plan is generated fresh but the plan is also a record of what was
 * decided, and a recurring goal deserves fresh content each time.
 *
 * So the two are separate, and the split is what makes a recurring goal
 * recurring rather than repeating.
 *
 * ## The one guarantee
 *
 * The returned text fits the platform's stated limit, or the step fails.
 *
 * Not "is trimmed to fit" — trimmed, in the sense of cut short, is a post that
 * ends mid-sentence or mid-hashtag, and a user cannot tell that from a post the
 * model wrote badly. So one re-ask is allowed, and if the second answer is still
 * too long the step fails with `invalid_content` and the run is reported. Two
 * attempts and a hard failure, against silent truncation, which is the
 * alternative that looks kinder and is not.
 *
 * ## No provider, no budget, no database
 *
 * `composePost` takes a `Completer` and returns a result. Provider resolution
 * and spend accounting happen in the caller — `src/lib/runtime/local-tools.ts`
 * — so that the part with the interesting decisions is testable without a key.
 */

import { describePlatformFor } from "./context";
import type { ConnectorError } from "@/lib/connectors/types";
import type { Completer } from "./planner";

export interface ComposeRequest {
  /** The direction, written by the planner. Not a draft. */
  brief: string;
  /** Voice override from the plan, if the planner set one. */
  tone?: string;
  /**
   * The platform the copy is for. Omit only when a plan composes text for no
   * particular platform — in which case there is no limit to fit and no rules
   * to obey.
   */
  platform?: string;
}

export type ComposeResult =
  | { ok: true; text: string; /** Whether a second attempt was needed for length. */ retried: boolean }
  | { ok: false; error: ConnectorError };

const SYSTEM_PROMPT = `You write one social media post. You are given a brief, an optional tone, and the platform the post is for.

Rules:
- Output the post text and nothing else. No preamble, no explanation, no label, no surrounding quotes.
- Fit the platform's stated limit exactly. Never exceed it, and never end with "..." to imply there was more.
- The platform's rules are constraints, not suggestions. Obey them even when the brief argues for something else.
- Never invent a statistic, a number, a customer name, a date, or an event. If the brief asks for one it does not supply, write the post without it.
- No block of hashtags at the end. Use a hashtag only where the platform's culture expects one.
- Plain text. Do not use markdown that the platform would show literally.`;

function contextLines(request: ComposeRequest): string[] {
  const lines = [`Brief: ${request.brief}`];
  if (request.tone) lines.push(`Tone: ${request.tone}`);

  if (request.platform) {
    const described = describePlatformFor(request.platform);
    lines.push(`Platform: ${described.name}`);
    if (described.maxTextLength !== null) {
      lines.push(`Hard limit: ${described.maxTextLength} characters.`);
    }
    if (described.rules.length > 0) {
      lines.push(`Platform rules: ${described.rules.join(" | ")}`);
    }
  }

  return lines;
}

export function buildComposeUserPrompt(request: ComposeRequest): string {
  return contextLines(request).join("\n");
}

/** The user half of the length re-ask, which names the number that failed. */
export function buildLengthRetryPrompt(request: ComposeRequest, previousLength: number): string {
  const described = describePlatformFor(request.platform ?? "");
  const limit = described.maxTextLength;
  return [
    "Your previous attempt was too long.",
    previousLength > 0 ? `It was ${previousLength} characters.` : null,
    limit !== null ? `The limit is ${limit} characters.` : null,
    "Rewrite it to fit. Cut whole clauses, not words — a shorter argument beats a truncated one.",
    "Output the post text and nothing else.",
    "",
    buildComposeUserPrompt(request),
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * Strip the wrappers a model puts around the thing it was asked for.
 *
 * Deliberately conservative. Every rule here removes something a *post* would
 * not contain: a code fence, a matched pair of surrounding quotes, a leading
 * label. Nothing that guesses — no "extract the first paragraph", no
 * "drop everything after 'Post:'" beyond a single leading label, because a
 * caption that legitimately contains the word "Post:" would be truncated into
 * something the user never wrote. Guessing here produces plausible text that is
 * not what the model meant, and it is published under the user's name.
 */
export function cleanPostText(raw: string): string {
  let text = raw.trim();
  if (!text) return text;

  const fence = /^```(?:[a-z]*)\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence?.[1] !== undefined) text = fence[1].trim();

  const first = text[0];
  const last = text[text.length - 1];
  if (
    text.length > 1 &&
    (first === '"' || first === "'" || first === "“") &&
    (last === '"' || last === "'" || last === "”")
  ) {
    const inner = text.slice(1, -1).trim();
    if (inner) text = inner;
  }

  // A single leading label, and only at the very start.
  return text.replace(/^(?:post|final post|caption|output)\s*:\s*/i, "").trim();
}

const failed = (
  code: ConnectorError["code"],
  message: string,
  retryable: boolean,
): ComposeResult => ({ ok: false, error: { code, message, retryable } });

export interface ComposeOptions {
  /**
   * Model calls this composition may make. One, plus one for a length
   * violation. Passed rather than imported so the bound is a parameter the
   * caller can see, and so the re-ask path is testable without a meter.
   */
  maxAttempts?: number;
}

/**
 * Write one post.
 *
 * `maxAttempts` is 2 by default, and the second is only ever spent on an
 * over-long answer.
 */
export async function composePost(
  request: ComposeRequest,
  complete: Completer,
  options: ComposeOptions = {},
): Promise<ComposeResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const limit = request.platform
    ? describePlatformFor(request.platform).maxTextLength
    : null;

  let userPrompt = buildComposeUserPrompt(request);
  let retried = false;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) retried = true;

    // A transport failure is thrown, not returned. The caller holds the
    // provider and the budget, so it is the only place that can say whether a
    // failure like this is worth retrying — and the answer differs per kind of
    // failure, which is exactly what a returned `ComposeResult` cannot express.
    const raw = await complete(SYSTEM_PROMPT, userPrompt);

    const text = cleanPostText(raw);

    if (!text) {
      return failed(
        "invalid_content",
        "The model returned nothing usable to publish.",
        false,
      );
    }

    if (limit !== null && text.length > limit) {
      if (attempt + 1 < maxAttempts) {
        userPrompt = buildLengthRetryPrompt(request, text.length);
        continue;
      }
      return failed(
        "invalid_content",
        `The post is ${text.length} characters and ${request.platform} allows ${limit}. It was not published rather than cut short.`,
        false,
      );
    }

    return { ok: true, text, retried };
  }

  /* c8 ignore next 2 -- unreachable: the loop returns on its last attempt. */
  return failed("invalid_content", "The post could not be written.", false);
}
