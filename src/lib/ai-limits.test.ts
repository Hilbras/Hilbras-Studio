import { describe, expect, it } from "vitest";

import {
  AI_BUDGET_DEFAULTS,
  AI_MAX_INPUT_CHARS,
  assertAiInputSize,
  assertAiOutputSize,
  countMessageChars,
  getAiBudgetLimit,
  getGlobalAiBudgetLimit,
} from "./ai-limits";

describe("AI limits", () => {
  it("counts message content without counting role metadata", () => {
    expect(
      countMessageChars([
        { content: "hello" },
        { content: " world" },
      ]),
    ).toBe(11);
  });

  it("rejects oversized input and output", () => {
    expect(() =>
      assertAiInputSize([{ content: "x".repeat(AI_MAX_INPUT_CHARS + 1) }]),
    ).toThrow(/too large/);
    expect(() => assertAiOutputSize("x".repeat(20_001))).toThrow(/maximum length/);
  });

  it("uses safe defaults and accepts positive environment overrides", () => {
    expect(getAiBudgetLimit("composer", {})).toBe(AI_BUDGET_DEFAULTS.composer);
    expect(getAiBudgetLimit("composer", { AI_COMPOSER_RATE_LIMIT: "7" })).toBe(7);
    expect(getGlobalAiBudgetLimit({ AI_GLOBAL_RATE_LIMIT: "250" })).toBe(250);
  });
});
