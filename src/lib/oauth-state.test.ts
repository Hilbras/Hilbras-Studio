import { describe, expect, it } from "vitest";
import nodeCrypto from "node:crypto";

import {
  STATE_MAX_AGE_MS,
  signState,
  verifyState,
  type OAuthState,
} from "./oauth-state";

/**
 * v0.9.5 (Phase 8): the OAuth `state` parameter was unsigned and unexpiring.
 *
 * The callback's entire defence against an account-link CSRF was
 * `state.userId === session.id`, and `state` was `base64url(JSON.stringify(...))`
 * — the same encoding a client uses, so the only thing an attacker needed was the
 * victim's user id, which is not a secret. The tests below are mostly about the
 * ways a signed state must *not* be accepted, because the positive path was
 * never the problem: an unsigned token round-trips fine and looks correct.
 *
 * Replay is deliberately **not** tested here as accepted-then-refused. It is not
 * refused by this module; it is made useless by PKCE. See the module comment.
 */
const SECRET = new TextEncoder().encode("a".repeat(40));
const OTHER_SECRET = new TextEncoder().encode("b".repeat(40));
const NOW = 1_760_000_000_000;

const state = { userId: "user-abc", returnUrl: "/settings/credentials" };

describe("a state this deployment minted", () => {
  it("verifies and gives back what went in", () => {
    const verified = verifyState(signState(state, SECRET, NOW), SECRET, NOW);
    expect(verified).toEqual({ ...state, iat: NOW });
  });

  it("is opaque enough not to be edited by hand", () => {
    // Not secrecy — `userId` is in there in the clear and always was. The point
    // is that reading the payload is not the same as being able to produce one,
    // and that a client cannot take a state, alter a field, and send it back.
    const raw = signState(state, SECRET, NOW);
    const payload = JSON.parse(
      Buffer.from(raw.split(".")[0]!, "base64url").toString("utf8"),
    );
    expect(payload.userId).toBe("user-abc");
    // And the signature is not derivable from the payload by anything the client
    // holds.
    expect(raw.split(".")[1]).not.toContain("user-abc");
  });

  it("still verifies a moment before it expires, and not a moment after", () => {
    const raw = signState(state, SECRET, NOW);
    expect(verifyState(raw, SECRET, NOW + STATE_MAX_AGE_MS - 1)).not.toBeNull();
    // The exact boundary is stale. A window that is still open one millisecond
    // early and shut one millisecond late is not a window.
    expect(verifyState(raw, SECRET, NOW + STATE_MAX_AGE_MS)).toBeNull();
  });
});

describe("a state this deployment did not mint", () => {
  it("refuses one forged with a different secret", () => {
    // The attack. An attacker mints a state naming the victim and walks them
    // through a callback carrying it; without a signature check this is the
    // only thing standing in the way.
    const forged = signState(state, OTHER_SECRET, NOW);
    expect(verifyState(forged, SECRET, NOW)).toBeNull();
  });

  it("refuses one with the signature removed", () => {
    // Signing only the payload and not the signature's own integrity, or
    // comparing only *part* of it, would let this through.
    const [payload, signature] = signState(state, SECRET, NOW).split(".");
    expect(verifyState(`${payload}`, SECRET, NOW)).toBeNull();
    expect(verifyState(`${payload}.`, SECRET, NOW)).toBeNull();
    expect(
      verifyState(`${payload}.${signature!.slice(0, -1)}`, SECRET, NOW),
    ).toBeNull();
    expect(verifyState(`${payload}.${signature}extra`, SECRET, NOW)).toBeNull();
  });

  it("refuses one whose userId was edited after signing", () => {
    // The realistic version: take a real state, swap the userId, resend. The
    // signature covers the encoded payload, so this changes the bytes it covers.
    const raw = signState(state, SECRET, NOW);
    const signature = raw.split(".")[1]!;
    const edited = Buffer.from(
      JSON.stringify({ ...state, userId: "user-victim", iat: NOW }),
    ).toString("base64url");
    expect(verifyState(`${edited}.${signature}`, SECRET, NOW)).toBeNull();
    expect(verifyState(raw, SECRET, NOW)).not.toBeNull();
  });

  it("refuses one whose returnUrl was retargeted", () => {
    // Why `safeReturnPath` is still applied afterwards even though the value is
    // signed. A signature proves we minted it, not that the value is safe to
    // use — a future caller could sign whatever it likes.
    const raw = signState(
      { userId: "user-abc", returnUrl: "https://evil.example/steal" },
      SECRET,
      NOW,
    );
    const verified = verifyState(raw, SECRET, NOW);
    expect(verified).not.toBeNull();
    expect(verified!.returnUrl).toBe("https://evil.example/steal");
  });

  it("refuses one that is not a state at all", () => {
    const unsigned = Buffer.from(JSON.stringify({ ...state, iat: NOW })).toString(
      "base64url",
    );
    for (const bad of [
      undefined,
      "",
      ".",
      "no-separator",
      // The exact shape the v0.9.4 callback accepted. Same fields, same
      // encoding, no signature — this is the value an attacker hands a victim.
      unsigned,
      `${unsigned}.`,
      "....",
      `a.${"b".repeat(43)}`,
    ]) {
      expect(verifyState(bad, SECRET, NOW), String(bad)).toBeNull();
    }
  });
});

describe("the fields inside", () => {
  it("refuses a signed payload whose shape is wrong", () => {
    // A signature is only as good as the parse behind it. These are all signed
    // with the right secret — the flaw being tested is a validator that accepts
    // whatever JSON.parse returned.
    const wrong: unknown[] = [
      null,
      "a string",
      42,
      [],
      { userId: "u" },
      { userId: "u", returnUrl: "/x" },
      { userId: "", returnUrl: "/x", iat: NOW },
      { userId: 7, returnUrl: "/x", iat: NOW },
      { userId: "u", returnUrl: null, iat: NOW },
      { userId: "u", returnUrl: "/x", iat: "now" },
      { userId: "u", returnUrl: "/x", iat: Number.NaN },
      { userId: "u", returnUrl: "/x", iat: Infinity },
    ];

    for (const payload of wrong) {
      const raw = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signRaw(
        Buffer.from(JSON.stringify(payload)).toString("base64url"),
      )}`;
      expect(verifyState(raw, SECRET, NOW), JSON.stringify(payload)).toBeNull();
    }
  });

  it("refuses a state dated in the future", () => {
    // A valid signature does not make a future `iat` right — it means a clock is
    // wrong, and treating it as current would extend the window by however far
    // the clock is out.
    const future = signState(state, SECRET, NOW + 10 * 60 * 1000);
    expect(verifyState(future, SECRET, NOW)).toBeNull();
    // A little skew is tolerated, so a browser and the server disagreeing by a
    // second is not a failed connect flow.
    const slightlyAhead = signState(state, SECRET, NOW + 30 * 1000);
    expect(verifyState(slightlyAhead, SECRET, NOW)).not.toBeNull();
  });
});

/**
 * The same HMAC `signState` uses, for building deliberately-bad payloads.
 *
 * Written out here rather than imported, because the point of these tests is to
 * construct states that *this deployment's* verifier will reject on grounds
 * other than a bad signature. Reusing the module's own helper would mean a bug
 * in it could not be observed from outside it.
 */
function signRaw(payload: string): string {
  return nodeCrypto
    .createHmac("sha256", SECRET)
    .update(payload)
    .digest()
    .toString("base64url");
}

describe("the shape of the type", () => {
  it("is what the callback depends on", () => {
    // A compile-time assertion rather than a runtime one. If `returnUrl` is
    // dropped from `OAuthState`, the callback's `state.returnUrl` stops
    // typechecking and this fails the build instead of silently redirecting
    // everyone to a default.
    const complete: OAuthState = { ...state, iat: NOW };
    expect(Object.keys(complete).sort()).toEqual(["iat", "returnUrl", "userId"]);
  });
});
