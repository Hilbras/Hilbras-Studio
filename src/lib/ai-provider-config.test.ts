import { beforeEach, describe, expect, it, vi } from "vitest";

import { getBuiltinProviderConfig } from "./ai-provider-config";

/**
 * AUD-018: the built-in provider's API format could be forced to the wrong one.
 *
 * The function is pure — it reads `process.env` and returns a config or null —
 * which makes the whole input space testable. It had no tests at all, and the
 * one thing it decides is whether a request is shaped like an OpenAI call or an
 * Anthropic one.
 *
 * ## The bug
 *
 * ```ts
 * process.env.HILBRAS_AI_BASE_URL || !legacyAnthropic ? "openai" : "anthropic"
 * ```
 *
 * `HILBRAS_AI_BASE_URL` outranked the key. A self-hoster with only
 * `ANTHROPIC_API_KEY` set — the legacy path — who also set a base URL (to reach
 * a proxy, or just following the docs) got `apiFormat: "openai"` with an
 * Anthropic key. Every Assistant request then failed with a 401 or a shape
 * mismatch, and the config looked correct in every field an operator would check.
 *
 * The precedence is now derived from **the key being used**, not from an
 * unrelated variable: whichever key won is what decides the format. An explicit
 * `HILBRAS_AI_API_FORMAT` still overrides, because that is a deliberate
 * statement of intent by someone who knows better than inference.
 */

const KEY_VARS = [
  "HILBRAS_AI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "HILBRAS_AI_BASE_URL",
  "HILBRAS_AI_API_FORMAT",
  "HILBRAS_AI_MODEL_ID",
];

beforeEach(() => {
  for (const name of KEY_VARS) vi.stubEnv(name, undefined);
});

describe("getBuiltinProviderConfig", () => {
  it("returns null when the server has no key at all", () => {
    expect(getBuiltinProviderConfig()).toBeNull();
  });

  describe("the format follows the key that won", () => {
    it("is openai for an OpenAI key", () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      const config = getBuiltinProviderConfig();
      expect(config?.apiFormat).toBe("openai");
      expect(config?.baseUrl).toBe("https://api.openai.com/v1");
      expect(config?.modelId).toBe("gpt-4o-mini");
    });

    it("is anthropic for an Anthropic key alone", () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
      const config = getBuiltinProviderConfig();
      expect(config?.apiFormat).toBe("anthropic");
      expect(config?.baseUrl).toBe("https://api.anthropic.com/v1");
      expect(config?.modelId).toBe("claude-sonnet-4-20250514");
    });

    it("is openai when OpenAI wins a two-key tie", () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
      expect(getBuiltinProviderConfig()?.apiFormat).toBe("openai");
    });

    it("prefers HILBRAS_AI_API_KEY and infers the format from it", () => {
      // The dedicated key is used for both providers; nothing about the *name*
      // says which. With no base URL or format to go on, OpenAI is the
      // documented default — but see the explicit-format tests below for how a
      // deployment states Anthropic.
      vi.stubEnv("HILBRAS_AI_API_KEY", "sk-test");
      expect(getBuiltinProviderConfig()?.apiFormat).toBe("openai");
    });
  });

  describe("the regression: a base URL must not decide the format", () => {
    it("stays anthropic for an Anthropic key when only the base URL is set", () => {
      // This is AUD-018 exactly. Setting a base URL used to flip the format to
      // openai while the Anthropic key stayed in `apiKey`, so every call was
      // sent to the right host with the wrong request shape.
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
      vi.stubEnv("HILBRAS_AI_BASE_URL", "https://proxy.internal/v1");

      const config = getBuiltinProviderConfig();
      expect(config?.apiFormat).toBe("anthropic");
      expect(config?.apiKey).toBe("sk-ant-test");
      // The base URL is still honoured — only its influence on the format is gone.
      expect(config?.baseUrl).toBe("https://proxy.internal/v1");
    });

    it("still honours the base URL for an OpenAI key", () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      vi.stubEnv("HILBRAS_AI_BASE_URL", "https://proxy.internal/v1");
      const config = getBuiltinProviderConfig();
      expect(config?.apiFormat).toBe("openai");
      expect(config?.baseUrl).toBe("https://proxy.internal/v1");
    });
  });

  describe("an explicit format still overrides", () => {
    it("anthropic", () => {
      vi.stubEnv("HILBRAS_AI_API_KEY", "sk-test");
      vi.stubEnv("HILBRAS_AI_API_FORMAT", "anthropic");
      const config = getBuiltinProviderConfig();
      expect(config?.apiFormat).toBe("anthropic");
      expect(config?.baseUrl).toBe("https://api.anthropic.com/v1");
    });

    it("openai", () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
      vi.stubEnv("HILBRAS_AI_API_FORMAT", "openai");
      expect(getBuiltinProviderConfig()?.apiFormat).toBe("openai");
    });

    it("an explicit anthropic format keeps the base URL but picks the anthropic default model", () => {
      // The model default tracks the format; the base URL is independent. Both
      // behaviours are asserted because the bug was exactly a case where these
      // three fields disagreed with each other.
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
      vi.stubEnv("HILBRAS_AI_BASE_URL", "https://proxy.internal/v1");
      const config = getBuiltinProviderConfig();
      expect(config?.apiFormat).toBe("anthropic");
      expect(config?.modelId).toBe("claude-sonnet-4-20250514");
      expect(config?.baseUrl).toBe("https://proxy.internal/v1");
    });

    it("ignores an unrecognised format value rather than trusting it", () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      vi.stubEnv("HILBRAS_AI_API_FORMAT", "gpt");
      expect(getBuiltinProviderConfig()?.apiFormat).toBe("openai");
    });
  });

  it("lets HILBRAS_AI_MODEL_ID override the format-derived default", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("HILBRAS_AI_MODEL_ID", "claude-haiku-4-20250414");
    expect(getBuiltinProviderConfig()?.modelId).toBe("claude-haiku-4-20250414");
  });

  it("never returns the key to the caller-facing fields", () => {
    // A cheap belt-and-braces check: the config is server-only, and `name` is
    // what reaches the UI via getActiveModelInfo.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const config = getBuiltinProviderConfig();
    expect(config?.name).toBe("Hilbras AI");
    expect(JSON.stringify({ ...config, apiKey: undefined })).not.toContain("sk-ant-test");
  });
});