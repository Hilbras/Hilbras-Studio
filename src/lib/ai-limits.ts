export const AI_MAX_INPUT_CHARS = 120_000;
export const AI_MAX_OUTPUT_CHARS = 20_000;
export const AI_DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
export const AI_BUDGET_WINDOW_SECONDS = 5 * 60;

export type AiBudgetKind =
  | "assistant"
  | "composer"
  | "suggestion"
  | "provider_test"
  | "memory"
  | "summary"
  /** Turning a goal statement into a plan. Phase 5. */
  | "planner"
  /** Writing the text a plan publishes. Phase 5. */
  | "compose";

export const AI_BUDGET_DEFAULTS: Record<AiBudgetKind, number> = {
  assistant: 20,
  composer: 30,
  suggestion: 20,
  provider_test: 10,
  memory: 20,
  summary: 10,
  planner: 10,
  compose: 30,
};

const AI_BUDGET_ENV: Record<AiBudgetKind, string> = {
  assistant: "ASSISTANT_RATE_LIMIT",
  composer: "AI_COMPOSER_RATE_LIMIT",
  suggestion: "AI_INBOX_RATE_LIMIT",
  provider_test: "AI_PROVIDER_TEST_RATE_LIMIT",
  memory: "AI_MEMORY_RATE_LIMIT",
  summary: "AI_SUMMARY_RATE_LIMIT",
  planner: "AI_PLANNER_RATE_LIMIT",
  compose: "AI_COMPOSE_RATE_LIMIT",
};

export function countMessageChars(
  messages: readonly { content: string }[],
): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

export function assertAiInputSize(
  messages: readonly { content: string }[],
): void {
  const chars = countMessageChars(messages);
  if (chars > AI_MAX_INPUT_CHARS) {
    throw new Error(
      `AI request is too large (${chars} characters; maximum ${AI_MAX_INPUT_CHARS})`,
    );
  }
}

export function assertAiOutputSize(text: string): void {
  if (text.length > AI_MAX_OUTPUT_CHARS) {
    throw new Error(
      `AI response exceeded the maximum length of ${AI_MAX_OUTPUT_CHARS} characters`,
    );
  }
}

export function getAiBudgetLimit(
  kind: AiBudgetKind,
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number.parseInt(env[AI_BUDGET_ENV[kind]] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : AI_BUDGET_DEFAULTS[kind];
}

export function getGlobalAiBudgetLimit(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number.parseInt(env.AI_GLOBAL_RATE_LIMIT ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
}
