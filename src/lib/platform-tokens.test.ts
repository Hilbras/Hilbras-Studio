import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOKEN_LIFETIME_SECONDS,
  effectiveTokenExpiry,
  isExpiredSessionError,
  supportsLongLivedToken,
  supportsTokenRefresh,
} from "./platform-tokens";

describe("platform token lifecycle helpers", () => {
  it("uses the fixed Meta lifetime when a refreshable token has no stored expiry", () => {
    const connectedAt = new Date("2026-01-01T00:00:00.000Z");
    const expiry = effectiveTokenExpiry("instagram", null, connectedAt);

    expect(expiry?.getTime()).toBe(
      connectedAt.getTime() + DEFAULT_TOKEN_LIFETIME_SECONDS * 1000,
    );
  });

  it("does not guess an expiry for platforms without a refresh lifecycle", () => {
    const connectedAt = new Date("2026-01-01T00:00:00.000Z");

    expect(effectiveTokenExpiry("x", null, connectedAt)).toBeNull();
  });

  it("identifies the platforms with long-lived exchange and refresh support", () => {
    expect(supportsLongLivedToken("instagram")).toBe(true);
    expect(supportsLongLivedToken("facebook")).toBe(true);
    expect(supportsLongLivedToken("x")).toBe(false);
    expect(supportsTokenRefresh("threads")).toBe(true);
    expect(supportsTokenRefresh("facebook")).toBe(false);
  });

  it("recognizes expired Meta sessions by code and message", () => {
    expect(
      isExpiredSessionError({ error: { code: 190, error_subcode: 463 } }),
    ).toBe(true);
    expect(
      isExpiredSessionError({
        error: { message: "Error validating access token: Session has expired on 2026-01-01" },
      }),
    ).toBe(true);
    expect(isExpiredSessionError({ error: { code: 190 } })).toBe(false);
    expect(isExpiredSessionError(null)).toBe(false);
  });
});
