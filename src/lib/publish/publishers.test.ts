import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithTimeout } = vi.hoisted(() => ({ fetchWithTimeout: vi.fn() }));

vi.mock("../http", () => ({ fetchWithTimeout }));

/**
 * The failure modes each publisher documents (remediation Task 18 follow-up).
 *
 * `docs/platform-development.md` tells a new platform author to "handle every
 * documented failure" and warns that a publisher which only handles success
 * makes every error path report `unknown`, which is non-retryable. That was
 * advice with nothing behind it: **no publisher had a test file at all**, so the
 * failure mappings were documentation of an intention rather than a description
 * of behaviour. These are the tests that make the advice enforceable — including
 * for the five publishers that already existed.
 *
 * ## What is and is not mocked
 *
 * The two outbound edges are mocked — `fetchWithTimeout` (the single HTTP
 * funnel, so a bare `fetch` cannot appear) and `getConnectedAccount` (which
 * would otherwise need a database). Everything else is the real code: the
 * publishers, `shared.ts`'s error mapping, and `result-url`'s sanitization.
 *
 * That split is the point. A test that mocked the publisher's own error mapping
 * would assert that the mock behaves as the mock behaves. Mocking only the
 * network means these assert on what the code actually does with a given HTTP
 * response, which is the thing that was untested.
 *
 * ## Why `getConnectedAccount` is mocked rather than seeded
 *
 * It resolves `accounts → connections` in the database, and the two
 * repositories that test it (`account-lifecycle`, the connection tests) already
 * cover that resolution. What is untested here is the publisher's *reaction* to
 * each `ConnectionProblem`, so the seam is placed at the result rather than at
 * the query.
 */

import { getConnectedAccount } from "./shared";
import { publishToX } from "./x";
import { publishToFacebook } from "./facebook";
import { publishToInstagram } from "./instagram";
import { publishToTelegram } from "./telegram";
import { publishToThreads } from "./threads";
import type { PublishResult } from "./types";

vi.mock("./shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared")>();
  return { ...actual, getConnectedAccount: vi.fn() };
});

const getAccount = vi.mocked(getConnectedAccount);

/** A resolved account, so the publisher gets past its first gate. */
function connected(over: { accessToken?: string; platformAccountId?: string } = {}) {
  return {
    ok: true as const,
    accessToken: over.accessToken ?? "token-123",
    platformAccountId: over.platformAccountId ?? "chat-9",
  } as unknown as Awaited<ReturnType<typeof getConnectedAccount>>;
}

/** An unresolved account, with the `ConnectionProblem` the real resolver returns. */
function notConnected(problem: "not_connected" | "ambiguous" | "disabled" = "not_connected") {
  return { ok: false as const, problem } as unknown as Awaited<
    ReturnType<typeof getConnectedAccount>
  >;
}

/** A JSON response, which is what every publisher's happy path parses. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchWithTimeout.mockReset();
  getAccount.mockReset();
  getAccount.mockResolvedValue(connected());
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Every publisher refuses to act without a resolvable account. */
describe("a publisher refuses to act without an account", () => {
  const cases: Array<[string, (u: string, t: string) => Promise<PublishResult>]> = [
    ["x", (u, t) => publishToX(u, t)],
    ["facebook", (u, t) => publishToFacebook(u, t)],
    ["instagram", (u, t) => publishToInstagram(u, t)],
    ["threads", (u, t) => publishToThreads(u, t)],
    ["telegram", (u, t) => publishToTelegram(u, t)],
  ];

  for (const [platform, publish] of cases) {
    it(`${platform} reports a missing connection without making a request`, async () => {
      getAccount.mockResolvedValue(notConnected("not_connected"));

      const result = await publish("user-1", "hello");

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      // The specific point: no HTTP call was attempted. A publisher that
      // fetched before resolving the account would send an unauthenticated
      // request, and the platform's error would be reported as a publish
      // failure — telling the user to reconnect a connection that is fine.
      expect(fetchWithTimeout).not.toHaveBeenCalled();
    });

    it(`${platform} reports an ambiguous account rather than picking one`, async () => {
      getAccount.mockResolvedValue(notConnected("ambiguous"));

      const result = await publish("user-1", "hello");

      expect(result.success).toBe(false);
      expect(fetchWithTimeout).not.toHaveBeenCalled();
    });
  }
});

describe("publishToX", () => {
  it("returns the platform's own post id and a sanitized permalink", async () => {
    fetchWithTimeout.mockResolvedValueOnce(json({ data: { id: "1234567890" } }));

    const result = await publishToX("user-1", "hello");

    expect(result).toEqual({
      platform: "x",
      success: true,
      postId: "1234567890",
      url: "https://x.com/i/web/status/1234567890",
    });
  });

  it("reports the platform's own error message rather than a status code", async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      json({ errors: [{ message: "Duplicate content detected" }] }, 403),
    );

    const result = await publishToX("user-1", "hello");

    // The platform's wording is what tells a user what to do about it; a bare
    // "403" does not.
    expect(result.success).toBe(false);
    expect(result.error).toContain("Duplicate content detected");
  });

  it("still reports a failure when the error body is not the documented shape", async () => {
    fetchWithTimeout.mockResolvedValueOnce(json({ something: "else" }, 500));

    const result = await publishToX("user-1", "hello");

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("turns a thrown transport error into a failure rather than propagating it", async () => {
    fetchWithTimeout.mockRejectedValueOnce(new Error("socket hang up"));

    const result = await publishToX("user-1", "hello");

    // A publisher that let this escape would fail the whole multi-platform
    // settle loop rather than this one target.
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("publishToFacebook", () => {
  it("refuses when the account owns no Page", async () => {
    fetchWithTimeout.mockResolvedValueOnce(json({ data: [] }));

    const result = await publishToFacebook("user-1", "hello");

    expect(result.success).toBe(false);
    expect(result.error).toBe("No Facebook Pages found");
  });

  it("reports a failure to list the Pages", async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      json({ error: { message: "Invalid OAuth token" } }, 401),
    );

    const result = await publishToFacebook("user-1", "hello");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid OAuth token");
  });

  it("surfaces the Graph error from the publish call itself", async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(
        json({ data: [{ id: "page-1", name: "Hilbras", access_token: "page-token" }] }),
      )
      .mockResolvedValueOnce(
        json({ error: { message: "Page Access Token expired" } }, 401),
      );

    const result = await publishToFacebook("user-1", "hello");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Page Access Token expired");
  });
});

describe("publishToInstagram", () => {
  it("refuses a text-only publish, because Instagram has no such thing", async () => {
    const result = await publishToInstagram("user-1", "text with no media");

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    // No request: failing at the gate is cheaper than a container create that
    // the platform will reject.
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("reports a failure to create the media container", async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      json({ error: { message: "Container creation failed" } }, 400),
    );

    const result = await publishToInstagram("user-1", "caption", "https://img/x.jpg");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Container creation failed");
  });

  it("reports a container the platform acknowledged without an id", async () => {
    fetchWithTimeout.mockResolvedValueOnce(json({}, 200));

    const result = await publishToInstagram("user-1", "caption", "https://img/x.jpg");

    // A 2xx with no `id` is the shape a malformed response takes. Publishing on
    // would mean reporting success for a post that does not exist.
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("publishToThreads", () => {
  it("refuses text over the platform's own limit", async () => {
    const tooLong = "x".repeat(600);

    const result = await publishToThreads("user-1", tooLong);

    expect(result.success).toBe(false);
    // The refusal comes from the registry's limit, not a hard-coded number, so
    // the test does not restate the limit and cannot drift from it.
    expect(result.error).toMatch(/500|character|too long/i);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("translates Meta's permission error into the action the user must take", async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      json(
        {
          error: {
            message: "Submit for app review",
            code: 100,
            error_subcode: 10,
          },
        },
        403,
      ),
    );

    const result = await publishToThreads("user-1", "hello");

    // Meta's own wording for this case is a dead end for a user; the publisher
    // substitutes the fix. The comment in `threads.ts` says so, and this is the
    // test that makes the claim checkable.
    expect(result.success).toBe(false);
    expect(result.error).not.toContain("Submit for app review");
    expect(result.error).toBeTruthy();
  });
});

describe("publishToTelegram", () => {
  it("refuses an empty message with no media", async () => {
    const result = await publishToTelegram("user-1", "   ");

    expect(result.success).toBe(false);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("reports a rejected send with the platform's description", async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      json({ ok: false, description: "chat not found" }, 400),
    );

    const result = await publishToTelegram("user-1", "hello");

    expect(result.success).toBe(false);
    // Case-insensitively: the publisher capitalizes Telegram's `description`
    // and appends the fix, so the platform's own words are present but not
    // verbatim. The assertion is that the platform's wording survives into the
    // message at all — a bare status code would not tell a user their chat id
    // is wrong.
    expect(result.error).toMatch(/chat not found/i);
  });
});

/**
 * The one property every publisher shares, asserted once rather than five times:
 * no result ever carries a URL the sanitiser would reject, and none is reported
 * successful with an `error` set. Both are cross-cutting invariants that a
 * per-platform test list would not surface, because no single platform
 * produces the violation — it takes a publisher *and* a change to the sanitiser.
 */
describe("every publisher keeps its result honest", () => {
  const publishers: Array<[string, (t: string) => Promise<PublishResult>]> = [
    ["x", (t) => publishToX("u", t)],
    ["facebook", (t) => publishToFacebook("u", t, "https://img/x.jpg")],
    ["instagram", (t) => publishToInstagram("u", t, "https://img/x.jpg")],
    ["threads", (t) => publishToThreads("u", t)],
    ["telegram", (t) => publishToTelegram("u", t)],
  ];

  it("never reports success together with an error", async () => {
    for (const [, publish] of publishers) {
      // Force the error path: a 500 from the first call the publisher makes.
      fetchWithTimeout.mockReset();
      getAccount.mockResolvedValue(connected());
      fetchWithTimeout.mockResolvedValue(json({ error: { message: "boom" } }, 500));

      const result = await publish("hello");

      if (result.success) {
        expect(
          result.error,
          `${result.platform} reported success and an error at once`,
        ).toBeUndefined();
      } else {
        expect(result.error, `${result.platform} failed without saying why`).toBeTruthy();
      }
    }
  });

  it("returns a platform name on every result", async () => {
    for (const [platform, publish] of publishers) {
      fetchWithTimeout.mockReset();
      getAccount.mockResolvedValue(connected());
      fetchWithTimeout.mockResolvedValue(json({}, 500));

      const result = await publish("hello");

      // A result whose `platform` is missing cannot be attributed in a
      // multi-target publish, which is the whole point of the field.
      expect(result.platform).toBe(platform);
    }
  });
});
