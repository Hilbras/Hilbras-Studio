import "server-only";

import {
  AI_BUDGET_WINDOW_SECONDS,
  getAiBudgetLimit,
  getGlobalAiBudgetLimit,
  type AiBudgetKind,
} from "@/lib/ai-limits";
import { log } from "./logger";
import { consumeRateLimit, type RateLimitOutcome } from "@/lib/rate-limit";

/**
 * Consume both the per-user and deployment-wide AI budgets for one model
 * operation. Database errors are intentionally allowed to propagate: callers
 * must fail closed rather than accidentally spend an unmetered provider key.
 */
export async function consumeAiBudget(
  userId: string,
  kind: AiBudgetKind,
): Promise<RateLimitOutcome> {
  if (!userId) throw new Error("AI budget requires a user id");

  const userBudget = await consumeRateLimit(
    `ai:${kind}:user:${userId}`,
    getAiBudgetLimit(kind),
    AI_BUDGET_WINDOW_SECONDS,
  );
  if (!userBudget.allowed) {
    log.warn("ai_budget_denied", { userId, kind, scope: "user" });
    return userBudget;
  }

  const global = await consumeRateLimit(
    "ai:global",
    getGlobalAiBudgetLimit(),
    AI_BUDGET_WINDOW_SECONDS,
  );
  if (!global.allowed) {
    log.warn("ai_budget_denied", { userId, kind, scope: "global" });
  }
  return global;
}

export function aiBudgetMessage(outcome: RateLimitOutcome): string {
  const seconds = outcome.retryAfterSec;
  return `AI usage limit reached. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
}
