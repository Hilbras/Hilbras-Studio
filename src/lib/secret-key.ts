/**
 * The HMAC key for sessions and OAuth state, read from `AUTH_SECRET`.
 *
 * ## Why this is its own module
 *
 * Until v0.9.5 this function was written out twice, identically: once in
 * `proxy.ts` and once in `lib/session.ts`. A third copy was about to be written
 * for the OAuth `state` signature. Three copies of a security check is two
 * copies too many, and v0.9.5 had already shipped a fix in one file for a bug
 * the other file still had — see the `matcher` drift in `src/proxy.test.ts`.
 *
 * ## Edge-safe on purpose
 *
 * `proxy.ts` runs in the Edge runtime, so this module must not reach for
 * `node:crypto`. `TextEncoder` and `process.env` are available in both runtimes,
 * which is why the session key is UTF-8 encoded rather than parsed as hex.
 */

/** The shortest secret accepted in production. See `getSecretKey` below. */
export const MIN_AUTH_SECRET_CHARS = 32;

/** Used only outside production, so a checkout runs unconfigured. */
const DEV_FALLBACK = "dev-only-insecure-secret-do-not-use-in-prod";

/**
 * Read `AUTH_SECRET` as key material, or fail loudly in production.
 *
 * Presence was checked and strength was not, which meant `AUTH_SECRET=x` — one
 * character — produced a deployment that would mint and verify every session
 * cookie for the life of the installation. A JWT signed with a guessable key is
 * forgeable by anyone who has ever seen a cookie, and nothing about the failure
 * looks like a failure: the tokens verify, they are just signed by a secret
 * anybody could have picked.
 *
 * So production requires both. The same rule now guards `ENCRYPTION_KEY`; see
 * `lib/crypto.ts`.
 */
export function getSecretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  const isProduction = process.env.NODE_ENV === "production";

  if (!secret && isProduction) {
    throw new Error("AUTH_SECRET must be set in production");
  }

  const effective = secret ?? DEV_FALLBACK;

  if (isProduction && effective.length < MIN_AUTH_SECRET_CHARS) {
    throw new Error(
      `AUTH_SECRET must be at least ${MIN_AUTH_SECRET_CHARS} characters in production. ` +
        "Generate one with: openssl rand -base64 32",
    );
  }

  return new TextEncoder().encode(effective);
}
