/**
 * The one place the Runtime calls a model.
 *
 * ## Why this is a single function
 *
 * Every model call the Runtime makes needs the same four things, and getting
 * any of them wrong in one of two call sites is how a run ends up spending
 * unmetered money: the provider the user configured, the deployment-wide
 * budget, the user's per-kind window budget, and the run's own ceiling.
 *
 * The run's own ceiling is checked *first*, before the rate limiter and before
 * the provider is even resolved. That ordering is the point. A refused call
 * must not touch the window budget, or a run that has spent its allowance eats
 * into the user's other AI features — the planner failing would throttle the
 * Assistant for no reason the user could act on.
 *
 * ## Errors are typed, because "is this retryable" is the Runtime's question
 *
 * Four distinct failures get four classes rather than one `Error`, and
 * `classifyAiError` turns any of them into a `ConnectorError` with the right
 * `retryable` flag:
 *
 * | Failure | Retryable | Because |
 * |---|---|---|
 * | The run spent its budget | no | Spending it again changes nothing. |
 * | The window budget is spent | yes | It clears in minutes. |
 * | No provider is configured | no | Only the user can fix it. |
 * | The provider errored | yes | Nothing was dispatched; see below. |
 *
 * The last one is the interesting contrast with a publish. A model call has no
 * side effect on the world, so retrying it cannot duplicate a post, and a 401
 * that will keep failing costs one wasted attempt rather than a duplicate. A
 * publish gets the opposite treatment (ADR-005), and both defaults are correct
 * because the two operations are not the same kind of thing.
 */

import "server-only";

import { resolveProviderForUser } from "@/lib/ai";
import { aiBudgetMessage, consumeAiBudget } from "@/lib/ai-budget";
import { chatCompletion as sdkChat } from "@/lib/ai-sdk";
import type { AiBudgetKind } from "@/lib/ai-limits";
import type { ConnectorError } from "@/lib/connectors/types";

import type { Completer } from "./planner";
import type { SpendDecision } from "./limits";

/** The run's own allowance is spent, or this step's share of it is. */
export class SpendExhaustedError extends Error {
  readonly decision: Extract<SpendDecision, { allowed: false }>;

  constructor(decision: Extract<SpendDecision, { allowed: false }>) {
    super(decision.message);
    this.name = "SpendExhaustedError";
    this.decision = decision;
  }
}

/** The per-user or per-deployment window budget is spent. */
export class AiBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiBudgetError";
  }
}

/** Nothing is configured to call. */
export class NoProviderError extends Error {
  constructor() {
    super(
      "No AI provider is configured. Add one in Settings → AI Provider, or the goal cannot run.",
    );
    this.name = "NoProviderError";
  }
}

export interface CompleterOptions {
  userId: string;
  /** Which window budget this kind of call spends. */
  kind: AiBudgetKind;
  /**
   * Charge this call against the run. Returns `allowed: false` to refuse, and
   * the refusal is thrown before anything else happens.
   */
  authorize: () => SpendDecision;
}

/** A `Completer` wired to a user's provider and to every budget that applies. */
export function createCompleter(options: CompleterOptions): Completer {
  return async (system, user) => {
    const decision = options.authorize();
    if (!decision.allowed) throw new SpendExhaustedError(decision);

    const budget = await consumeAiBudget(options.userId, options.kind);
    if (!budget.allowed) throw new AiBudgetError(aiBudgetMessage(budget));

    const provider = await resolveProviderForUser(options.userId);
    if (!provider) throw new NoProviderError();

    return sdkChat(provider, [
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
  };
}

/**
 * Turn a thrown model-call failure into a Runtime error.
 *
 * The fallback case is a provider HTTP error. `sdkChat` throws for a 4xx and a
 * 5xx alike and does not surface the status, so the Runtime cannot tell a bad
 * key from a rate limit and marks it retryable. That is the right default
 * *here* precisely because nothing was dispatched — the asymmetry with
 * `publish_post`, whose unknown outcomes are never retried, is the whole reason
 * both defaults exist.
 */
export function classifyAiError(cause: unknown): ConnectorError {
  if (cause instanceof SpendExhaustedError) {
    return { code: "budget_exhausted", message: cause.message, retryable: false };
  }
  if (cause instanceof AiBudgetError) {
    return { code: "rate_limited", message: cause.message, retryable: true };
  }
  if (cause instanceof NoProviderError) {
    return { code: "not_connected", message: cause.message, retryable: false };
  }
  if (cause instanceof Error && cause.message) {
    return {
      code: "platform_error",
      message: `The model could not be reached: ${cause.message}`,
      retryable: true,
    };
  }
  return {
    code: "unknown",
    message: "The model call failed for an unknown reason.",
    retryable: false,
  };
}
