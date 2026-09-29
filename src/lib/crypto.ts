import "server-only";
import crypto from "node:crypto";

/**
 * Token encryption at rest.
 *
 * User OAuth tokens (access/refresh) are encrypted with AES-256-GCM
 * before being written to the database, using a server-side master key
 * from ENCRYPTION_KEY. A database dump alone therefore reveals nothing.
 *
 * Payload format: base64url(iv).base64url(authTag).base64url(ciphertext)
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * The shortest key accepted in production.
 *
 * `openssl rand -hex 32` produces 64 hex characters and is what the README tells
 * an operator to run. A passphrase is still accepted and stretched with scrypt,
 * but it has to be long enough to be worth stretching: `ENCRYPTION_KEY=a` used
 * to produce a perfectly working 32-byte key, and that is the worst outcome
 * available — the deployment starts, encrypts every OAuth token in the database
 * with something derived from one character, and nothing anywhere reports a
 * problem. Presence was checked; strength was not.
 */
const MIN_KEY_CHARS = 32;

/** Used only when `NODE_ENV` is not production, so a checkout runs unconfigured. */
const DEV_FALLBACK = "dev-only-insecure-encryption-key-change-before-production";

function getMasterKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  const isProduction = process.env.NODE_ENV === "production";

  if (!raw && isProduction) {
    throw new Error("ENCRYPTION_KEY must be set in production");
  }

  const effective = raw ?? DEV_FALLBACK;

  if (isProduction && effective.length < MIN_KEY_CHARS) {
    throw new Error(
      `ENCRYPTION_KEY must be at least ${MIN_KEY_CHARS} characters in production. ` +
        "Generate one with: openssl rand -hex 32",
    );
  }

  // Prefer a raw 32-byte hex key (openssl rand -hex 32);
  // fall back to deriving one deterministically from any passphrase.
  if (/^[0-9a-f]{64}$/i.test(effective)) {
    return Buffer.from(effective, "hex");
  }
  return crypto.scryptSync(effective, "hilbras-studio.v1", KEY_BYTES);
}

/** Encrypt a secret (e.g. an OAuth access token) for storage. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getMasterKey(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/** Decrypt a payload produced by encryptSecret. Throws if tampered or wrong key. */
export function decryptSecret(payload: string): string {
  const [ivPart, tagPart, dataPart] = payload.split(".");
  // `undefined` rather than falsy, because an *empty* secret encrypts to an empty
  // ciphertext and `base64url("")` is `""`. A truthiness check here made
  // `decryptSecret(encryptSecret(""))` throw "malformed" on a payload this
  // module had itself just written — found by the round-trip test in v0.9.5.
  if (ivPart === undefined || tagPart === undefined || dataPart === undefined) {
    throw new Error("Malformed encrypted payload");
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getMasterKey(),
    Buffer.from(ivPart, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** Safe display form for UIs — never exposes the full value. */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return "••••••••";
  return `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}

/** Generate a fresh master key (for setup tooling / .env.example guidance). */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(KEY_BYTES).toString("hex");
}