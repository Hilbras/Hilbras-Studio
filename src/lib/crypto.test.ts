import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  generateEncryptionKey,
  maskSecret,
} from "./crypto";

/**
 * v0.9.5 (Phase 8): the foundation every stored secret rests on, untested.
 *
 * Every OAuth access token, every client secret, and every AI provider key in
 * the database is encrypted and decrypted here and nowhere else. A defect in this
 * file is a defect in all of them at once, and until this release the only thing
 * asserting it worked was a credential actually being published.
 *
 * The properties worth holding are the ones whose failure is silent. A wrong key
 * throws, so it is noticed. A *reused IV* does not throw — it quietly destroys
 * the confidentiality of every message encrypted under it, and the only evidence
 * is the source. So IV freshness is asserted directly rather than inferred from
 * the round trip passing.
 */
const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);

// `vi.stubEnv` rather than `process.env.NODE_ENV = ...`: the property is
// readonly in Node's type definitions, and casting past that to change a global
// in a test file is a small dishonesty the compiler is right to object to.
beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEY", KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The production setup, with `ENCRYPTION_KEY` set to `key`. */
function asProduction(key?: string) {
  vi.stubEnv("NODE_ENV", "production");
  if (key === undefined) vi.stubEnv("ENCRYPTION_KEY", undefined);
  else vi.stubEnv("ENCRYPTION_KEY", key);
}

describe("encrypting a secret", () => {
  it("round-trips, including text that looks like a payload", () => {
    vi.stubEnv("ENCRYPTION_KEY", KEY);
    const secrets = [
      "a-token",
      // The payload separator. A naive implementation that split on `.` would
      // truncate this, and an OAuth token is an opaque string from a third party
      // with no reason to avoid our delimiter.
      "has.dots.in.it",
      "",
      "ünïcödé ✓ 🔐",
      "x".repeat(4096),
    ];

    for (const secret of secrets) {
      expect(decryptSecret(encryptSecret(secret))).toBe(secret);
    }
  });

  it("uses a fresh IV every time, so one plaintext has many ciphertexts", () => {
    // The property that cannot be checked by round-tripping. GCM's security
    // collapses entirely under a reused nonce: the same key and the same IV
    // makes the ciphertext XOR of the two plaintexts, and the auth tag for one
    // authenticates the other. Nothing throws when this breaks.
    const plaintext = "the same token twice";
    const payloads = new Set(
      Array.from({ length: 32 }, () => encryptSecret(plaintext)),
    );

    expect(payloads.size).toBe(32);
    // And the IV really is the varying part, rather than something else changing
    // while a fixed IV is reused.
    const ivs = new Set(
      [...payloads].map((payload) => payload.split(".")[0]),
    );
    expect(ivs.size).toBe(32);
  });

  it("keeps the plaintext out of the stored payload", () => {
    const payload = encryptSecret("super-secret-token-value");
    expect(payload).not.toContain("super-secret-token-value");
    // Three parts: iv, auth tag, ciphertext. The shape is load-bearing —
    // `decryptSecret` reads them positionally.
    expect(payload.split(".")).toHaveLength(3);
  });
});

describe("refusing a payload that cannot be trusted", () => {
  it("rejects a tampered ciphertext", () => {
    const [iv, tag, data] = encryptSecret("a-token").split(".");
    // Flip one character of the ciphertext. GCM's auth tag is what makes this
    // detectable, and it is the reason this is AEAD and not plain encryption.
    const flipped =
      (data!.startsWith("A") ? "B" : "A") + data!.slice(1);
    expect(() => decryptSecret([iv, tag, flipped].join("."))).toThrow();
  });

  it("rejects a swapped auth tag", () => {
    const [iv, , data] = encryptSecret("a-token").split(".");
    expect(() => decryptSecret([iv, "AAAA", data!].join("."))).toThrow();
  });

  it("rejects a payload encrypted under a different key", () => {
    const payload = encryptSecret("a-token");
    vi.stubEnv("ENCRYPTION_KEY", OTHER_KEY);
    // This is what rotating ENCRYPTION_KEY looks like today, and it is why
    // rotation is not in this release: there is no key id in the payload, so the
    // old value cannot be tried and the failure is indistinguishable from
    // tampering. See docs/architecture.md.
    expect(() => decryptSecret(payload)).toThrow();
  });

  it("rejects a malformed payload rather than returning something", () => {
    for (const bad of ["", "only-one-part", "two.parts", "a.b.c.d"]) {
      expect(() => decryptSecret(bad), bad).toThrow();
    }
  });
});

describe("the master key", () => {
  it("refuses an absent key in production", () => {
    asProduction(undefined);
    expect(() => encryptSecret("a-token")).toThrow(/must be set/);
  });

  it("refuses a key too short to be a key in production", () => {
    // The gap this release closes. Presence was checked and strength was not, so
    // a one-character ENCRYPTION_KEY produced a working deployment that
    // encrypted every token in the database with something scrypt could not fix.
    for (const weak of ["a", "hunter2", "x".repeat(31)]) {
      asProduction(weak);
      expect(() => encryptSecret("a-token"), weak).toThrow(/at least 32/);
    }
  });

  it("accepts a documented hex key in production", () => {
    asProduction(generateEncryptionKey());
    expect(decryptSecret(encryptSecret("a-token"))).toBe("a-token");
  });

  it("accepts a long passphrase in production, and stretches it", () => {
    asProduction("a memorable passphrase, and not hex at all");
    const payload = encryptSecret("a-token");
    expect(decryptSecret(payload)).toBe("a-token");

    // Deterministic: the same passphrase must keep reading what it wrote, or a
    // restart would orphan every stored secret. scrypt is a KDF, not a nonce —
    // the same key in gives the same key out, every time.
    expect(decryptSecret(payload)).toBe("a-token");
  });

  it("still runs unconfigured outside production, so a checkout works", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ENCRYPTION_KEY", undefined);
    expect(decryptSecret(encryptSecret("a-token"))).toBe("a-token");
  });

  it("generates a key the documented way", () => {
    // What `openssl rand -hex 32` produces, and what getMasterKey reads as raw
    // key material rather than stretching. If this changed, every deployment
    // following the README would fall into the passphrase path and — worse —
    // still work, silently.
    const generated = generateEncryptionKey();
    expect(generated).toMatch(/^[0-9a-f]{64}$/);
    expect(generated).not.toBe(generateEncryptionKey());
  });
});

describe("masking a secret for display", () => {
  it("shows the ends and nothing in between", () => {
    expect(maskSecret("abcdefghijklmnop")).toBe("abcd••••mnop");
  });

  it("shows nothing at all for a secret too short to show ends of", () => {
    // Eight real characters out of a twelve-character secret is most of it. The
    // whole value is masked below the length where the ends are not worth
    // disclosing, so a UI can pass any secret without checking its length first.
    for (const short of ["", "a", "abcdefgh", "12345678"]) {
      expect(maskSecret(short)).toBe("••••••••");
    }
  });
});
