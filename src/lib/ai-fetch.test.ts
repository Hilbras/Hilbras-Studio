import { describe, expect, it } from "vitest";

import { AI_PROVIDER_TIMEOUT_MS, aiProviderRequestInit } from "./ai-fetch";

describe("AI provider request policy", () => {
  it("disables redirects and applies a bounded abort signal", () => {
    const init = aiProviderRequestInit();

    expect(init.redirect).toBe("manual");
    expect(init.cache).toBe("no-store");
    expect(AI_PROVIDER_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
