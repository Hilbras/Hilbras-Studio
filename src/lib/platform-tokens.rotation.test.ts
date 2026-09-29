import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithTimeout } = vi.hoisted(() => ({ fetchWithTimeout: vi.fn() }));

vi.mock("./http", () => ({ fetchWithTimeout }));

import { refreshRotatingToken, supportsTokenRotation } from "./platform-tokens";

/**
 * Contract for the rotating-refresh-token path (remediation Task 9): X's
 * access token lives 2 hours and every refresh replaces the refresh token,
 * so the call authenticates the app with HTTP Basic and the caller must
 * persist both new tokens together.
 */
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchWithTimeout.mockReset();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("refreshRotatingToken", () => {
  it("posts Basic-authenticated credentials and returns both new tokens", async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "new-at",
          refresh_token: "new-rt",
          expires_in: 7200,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const rotated = await refreshRotatingToken("x", "old-rt", "cid", "csec");

    expect(rotated).toEqual({
      accessToken: "new-at",
      refreshToken: "new-rt",
      expiresIn: 7200,
    });

    const [url, init] = fetchWithTimeout.mock.calls[0]!;
    expect(url).toBe("https://api.x.com/2/oauth2/token");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("cid:csec").toString("base64")}`,
    );
    const body = String(init?.body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=old-rt");
    expect(body).toContain("client_id=cid");
  });

  it("refuses a partial answer — a refresh token must always come back", async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "only-at" }), { status: 200 }),
    );

    await expect(
      refreshRotatingToken("x", "old-rt", "cid", "csec"),
    ).resolves.toBeNull();
  });

  it("returns null on an error status", async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 401 }),
    );

    await expect(
      refreshRotatingToken("x", "old-rt", "cid", "csec"),
    ).resolves.toBeNull();
  });

  it("declares exactly the rotation-based platforms", () => {
    expect(supportsTokenRotation("x")).toBe(true);
    expect(supportsTokenRotation("instagram")).toBe(false);
    expect(supportsTokenRotation("reddit")).toBe(false);
  });
});
