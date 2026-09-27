import { describe, expect, it } from "vitest";

import { getSignupPolicy, isValidInviteCode } from "./signup-policy";

describe("signup policy", () => {
  it("keeps public signup enabled by default", () => {
    expect(getSignupPolicy({})).toEqual({
      publicSignupEnabled: true,
      inviteRequired: false,
    });
  });

  it("supports disabled public signup and required invite codes", () => {
    const env = { ALLOW_PUBLIC_SIGNUP: "0", SIGNUP_INVITE_CODE: "launch-2026" };

    expect(getSignupPolicy(env)).toEqual({
      publicSignupEnabled: false,
      inviteRequired: true,
    });
    expect(isValidInviteCode("launch-2026", env)).toBe(true);
    expect(isValidInviteCode("wrong", env)).toBe(false);
  });
});
