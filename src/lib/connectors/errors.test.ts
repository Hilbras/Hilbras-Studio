import { describe, expect, it } from "vitest";

import { classifyLegacyError, unknownError } from "./errors";

/**
 * The classifier is the only place the legacy publishers' free-text errors are
 * interpreted. Its output decides whether the Runtime retries, so the two
 * properties that matter are: a code is never left `unknown` when the cause is
 * recognisable, and `retryable` is only ever true where a retry is safe.
 */
describe("classifyLegacyError", () => {
  it("separates the two connection states, which need different user actions", () => {
    expect(classifyLegacyError("x", "X not connected").code).toBe(
      "not_connected",
    );
    expect(
      classifyLegacyError(
        "instagram",
        "Instagram: the session expired and must be renewed — reconnect from Accounts → Instagram → Config → Reconnect via OAuth.",
      ).code,
    ).toBe("expired");
  });

  it("recognises an unsupported publisher", () => {
    expect(
      classifyLegacyError("linkedin", "Publishing not yet supported for linkedin")
        .code,
    ).toBe("unsupported");
    expect(
      classifyLegacyError("tiktok", "Publishing is not implemented yet.").code,
    ).toBe("unsupported");
  });

  it("distinguishes an unreachable target from a broken connection", () => {
    // Both need a user action, but they are different actions: the grant is
    // fine and only the account behind it is gone.
    expect(
      classifyLegacyError(
        "telegram",
        "Chat not found — check the chat ID and that the bot is still a member of it.",
      ).code,
    ).toBe("target_unavailable");
    expect(classifyLegacyError("telegram", "X not connected").code).toBe(
      "not_connected",
    );
  });

  it("classifies permission failures ahead of throttling", () => {
    expect(
      classifyLegacyError("telegram", "Bot doesn't have enough rights").code,
    ).toBe("forbidden");
    expect(classifyLegacyError("x", "Forbidden").code).toBe("forbidden");
  });

  it("classifies throttling and content rejections distinctly", () => {
    expect(
      classifyLegacyError("x", "Rate limit exceeded, please try again later").code,
    ).toBe("rate_limited");
    expect(
      classifyLegacyError("x", "Your post is too long for this platform").code,
    ).toBe("invalid_content");
  });

  it("marks only transient codes retryable", () => {
    expect(classifyLegacyError("x", "Rate limit exceeded").retryable).toBe(true);
    expect(classifyLegacyError("x", "Platform had an internal error").retryable).toBe(
      false,
    );
    expect(classifyLegacyError("x", "X not connected").retryable).toBe(false);
    expect(classifyLegacyError("x", "session expired").retryable).toBe(false);
  });

  it("fails closed on anything unrecognised", () => {
    // An unclassified failure on a side-effecting step is the "uncertain
    // outcome" case: the dispatcher may already have succeeded, so retrying
    // could double-post. Never retryable.
    const result = classifyLegacyError("x", "something nobody has seen before");
    expect(result.code).toBe("unknown");
    expect(result.retryable).toBe(false);
  });

  it("preserves the human-readable message verbatim", () => {
    const message = "X: the session expired and must be renewed.";
    expect(classifyLegacyError("x", message).message).toBe(message);
  });
});

describe("unknownError", () => {
  it("reads a message out of a thrown Error", () => {
    expect(unknownError("x", new Error("socket hang up")).message).toBe(
      "socket hang up",
    );
  });

  it("falls back to a platform-scoped message for a non-Error throw", () => {
    expect(unknownError("threads", "a string").message).toBe(
      "threads publish failed",
    );
    expect(unknownError("threads", undefined).retryable).toBe(false);
  });
});
