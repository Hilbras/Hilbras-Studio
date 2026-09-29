import "server-only";

import crypto from "node:crypto";

/**
 * The OAuth `state` parameter, signed.
 *
 * ## What was wrong
 *
 * Until v0.9.5 the state was `base64url(JSON.stringify({ userId, returnUrl }))` —
 * readable by anyone, forgeable by anyone. The only thing the callback checked
 * was `state.userId === session.id`, so the entire protection against an
 * account-link CSRF was *knowing the victim's user id*. That attack is
 * account-takeover-adjacent and it is not hard: an attacker starts their own
 * connect flow, takes the authorization code returned to their own callback, and
 * walks a victim through a callback URL carrying that code and a `state` naming
 * them. The victim's account is then linked to the attacker's social account.
 *
 * ## What is signed, and what is not
 *
 * The payload is signed with `AUTH_SECRET` and compared in constant time, so a
 * `state` that did not come from this deployment's `/authorize` is rejected
 * before it is parsed — the parse is not the security boundary, the signature
 * is. `iat` is inside the signed payload, so an attacker cannot age a forged
 * state forward to stay inside the window.
 *
 * **This does not make `state` single-use, and does not need to.** Replaying a
 * *captured genuine* state still requires a `code` that the platform issued for
 * that same flow, and the token exchange sends the `code_verifier` whose only
 * copy is the httpOnly `pkce_<platform>` cookie. An attacker holding a captured
 * state string does not hold that cookie, so the replay cannot complete. Signing
 * closes the forgery; PKCE closes the replay. Both are needed and neither
 * substitutes for the other.
 */
export interface OAuthState {
  userId: string;
  returnUrl: string;
  /** When this state was minted, ms since the epoch. Inside the signature. */
  iat: number;
}

/**
 * How long a state stays acceptable.
 *
 * Ten minutes, matching the `pkce_<platform>` cookie's `maxAge`. A state outliving
 * its own PKCE verifier would be a state that can no longer complete a flow, so
 * accepting it longer buys nothing.
 */
export const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/** A little clock skew, so a browser and the server disagreeing by a second is fine. */
const CLOCK_SKEW_MS = 60 * 1000;

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url");

/**
 * Mint a state. The signature is the second half, separated by a `.`.
 *
 * Takes key material rather than a string so this module never has to know how
 * `AUTH_SECRET` is read — `getSecretKey` in `lib/secret-key.ts` returns
 * `Uint8Array` and enforces the production rules.
 */
export function signState(
  state: Omit<OAuthState, "iat">,
  secret: Uint8Array,
  now: number = Date.now(),
): string {
  const payload = b64url(JSON.stringify({ ...state, iat: now }));
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Check a state and return it, or `null` for anything unacceptable.
 *
 * `null` rather than a throw, and deliberately undifferentiated: the caller
 * redirects to a failure page either way, and an error that said *which* check
 * failed would be a debugging aid for whoever is trying to forge one.
 */
export function verifyState(
  raw: string | undefined,
  secret: Uint8Array,
  now: number = Date.now(),
): OAuthState | null {
  if (!raw) return null;

  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return null;

  const payload = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);

  // Before the parse. A signature that does not verify means the bytes are not
  // ours, and parsing them anyway would be treating attacker input as state.
  if (!verifySignature(payload, signature, secret)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate.userId !== "string" || candidate.userId === "") return null;
  if (typeof candidate.returnUrl !== "string") return null;
  if (typeof candidate.iat !== "number" || !Number.isFinite(candidate.iat)) {
    return null;
  }

  // A state from the future is as suspect as a stale one, and the signature being
  // valid does not make it right — it means a clock is wrong somewhere.
  if (candidate.iat > now + CLOCK_SKEW_MS) return null;
  // Inclusive, matching `isOverdue` in the approvals store: a state is stale the
  // instant it reaches the end of its window, not one millisecond later. Two
  // places in this codebase that both mean "expired" should not answer
  // differently at the boundary.
  if (now - candidate.iat >= STATE_MAX_AGE_MS) return null;

  return {
    userId: candidate.userId,
    returnUrl: candidate.returnUrl,
    iat: candidate.iat,
  };
}

function sign(payload: string, secret: Uint8Array): string {
  return b64url(crypto.createHmac("sha256", secret).update(payload).digest());
}

function verifySignature(
  payload: string,
  signature: string,
  secret: Uint8Array,
): boolean {
  const expected = Buffer.from(sign(payload, secret), "base64url");
  const actual = Buffer.from(signature, "base64url");
  // `timingSafeEqual` throws on a length mismatch, and the length is itself
  // attacker-controlled, so the equal-length case is checked first.
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}
