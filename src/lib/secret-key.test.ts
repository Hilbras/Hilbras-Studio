import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MIN_AUTH_SECRET_CHARS, getSecretKey } from "./secret-key";

/**
 * v0.9.5 (Phase 8): `getSecretKey` was written out twice — in `proxy.ts` and in
 * `lib/session.ts` — and a fix to one of them would not have reached the other.
 * This is the file they now share, so this is the file that has to be right.
 *
 * The strength rule is new. `AUTH_SECRET` was checked for presence and not for
 * length, which made `AUTH_SECRET=x` a valid production configuration: a
 * deployment that would sign every session cookie for its lifetime with a single
 * character. A JWT with a guessable key is forgeable by anyone who has ever seen
 * a cookie, and the tokens still verify, so nothing looks wrong.
 */
beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const asProduction = () => vi.stubEnv("NODE_ENV", "production");
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("in production", () => {
  it("refuses to run without a secret at all", () => {
    asProduction();
    expect(() => getSecretKey()).toThrow(/AUTH_SECRET must be set/);
  });

  it("refuses a secret too short to be a secret", () => {
    asProduction();
    for (const weak of ["x", "hunter2", "a".repeat(MIN_AUTH_SECRET_CHARS - 1)]) {
      vi.stubEnv("AUTH_SECRET", weak);
      expect(() => getSecretKey(), `${weak.length} chars`).toThrow(
        new RegExp(`at least ${MIN_AUTH_SECRET_CHARS}`),
      );
    }
  });

  it("says how to fix it, because an error an operator cannot act on gets a ticket", () => {
    asProduction();
    vi.stubEnv("AUTH_SECRET", "x");
    // The message is the user interface for a startup crash.
    expect(() => getSecretKey()).toThrow(/openssl rand -base64 32/);
  });

  it("accepts a secret at exactly the minimum", () => {
    // The boundary is the point where the answer changes, so it is the point
    // worth testing. A limit of `>` instead of `>=` would silently reject the
    // documented `openssl rand -base64 32` output length.
    asProduction();
    vi.stubEnv("AUTH_SECRET", "a".repeat(MIN_AUTH_SECRET_CHARS));
    expect(decode(getSecretKey())).toHaveLength(MIN_AUTH_SECRET_CHARS);
  });

  it("returns the secret, and the same secret every time", () => {
    // Both callers depend on this being the *same* value: the middleware signs
    // and verifies with it, and so does the session module. A per-call random or
    // a per-call transform would make every request a 401 with no cause.
    asProduction();
    vi.stubEnv("AUTH_SECRET", "a".repeat(MIN_AUTH_SECRET_CHARS));
    expect(decode(getSecretKey())).toBe(decode(getSecretKey()));
    expect(decode(getSecretKey())).toBe("a".repeat(MIN_AUTH_SECRET_CHARS));
  });
});

describe("outside production", () => {
  it("falls back, so a checkout runs with no configuration", () => {
    vi.stubEnv("NODE_ENV", "development");
    // A checkout that refuses to start without three environment variables is a
    // checkout nobody runs. The fallback is only reachable here because the
    // production branch above throws first.
    expect(getSecretKey().length).toBeGreaterThan(0);
  });

  it("still prefers a configured secret over the fallback", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_SECRET", "a-real-secret-set-for-local-development");
    expect(decode(getSecretKey())).toBe("a-real-secret-set-for-local-development");
  });
});

describe("the shape of the key material", () => {
  it("is bytes, usable directly as an HMAC key", () => {
    // `Uint8Array` rather than a string because both callers hand it straight to
    // `jose` and to `crypto.createHmac`, and because the OAuth state signature
    // must be verifiable with the *same* bytes the session cookie was signed
    // with. If this ever returned a string, a hex-vs-utf8 disagreement between
    // the two consumers would look like a mystery.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_SECRET", "abc");
    const key = getSecretKey();
    expect(key).toBeInstanceOf(Uint8Array);
    // UTF-8 encoded, not hex-parsed: `proxy.ts` runs in the Edge runtime, where
    // `node:crypto` is unavailable, so this module cannot parse hex.
    expect(key).toEqual(new TextEncoder().encode("abc"));
  });
});
