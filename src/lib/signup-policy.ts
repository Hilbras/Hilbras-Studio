export interface SignupPolicy {
  publicSignupEnabled: boolean;
  inviteRequired: boolean;
}

export function getSignupPolicy(
  env: Record<string, string | undefined> = process.env,
): SignupPolicy {
  return {
    publicSignupEnabled: env.ALLOW_PUBLIC_SIGNUP !== "0",
    inviteRequired: Boolean(env.SIGNUP_INVITE_CODE?.trim()),
  };
}

export function isValidInviteCode(
  code: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const expected = env.SIGNUP_INVITE_CODE?.trim();
  if (!expected) return true;
  return code?.trim() === expected;
}
