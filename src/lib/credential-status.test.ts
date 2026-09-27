import { describe, expect, it } from "vitest";

import { toPlatformCredentialStatus } from "./credential-status";

describe("platform credential status DTO", () => {
  it("reports secret presence without returning the secret", () => {
    const status = toPlatformCredentialStatus("client-id", "super-secret-value");

    expect(status).toEqual({ clientId: "client-id", hasClientSecret: true });
    expect(Object.values(status)).not.toContain("super-secret-value");
  });

  it("represents missing credentials without leaking null details", () => {
    expect(toPlatformCredentialStatus(null, null)).toEqual({
      clientId: null,
      hasClientSecret: false,
    });
  });
});
