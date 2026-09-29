import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { getSessionUser, verifyState, getSecretKey, readPlatformAppCredentials, registerConnection, fetchWithTimeout } =
  vi.hoisted(() => ({
    getSessionUser: vi.fn(),
    verifyState: vi.fn(),
    getSecretKey: vi.fn(),
    readPlatformAppCredentials: vi.fn(),
    registerConnection: vi.fn(),
    fetchWithTimeout: vi.fn(),
  }));

vi.mock("@/lib/session", () => ({ getSessionUser }));
vi.mock("@/lib/oauth-state", () => ({ verifyState }));
vi.mock("@/lib/secret-key", () => ({ getSecretKey: getSecretKey as unknown as () => string }));
vi.mock("@/lib/platform-credentials", () => ({ readPlatformAppCredentials }));
vi.mock("@/lib/accounts/store", () => ({ registerConnection }));
vi.mock("@/lib/crypto", () => ({ encryptSecret: (v: string) => `enc:${v}` }));
vi.mock("@/lib/http", () => ({ fetchWithTimeout }));

import { GET } from "./route";

/**
 * Contract tests for the OAuth callback (remediation Task 9): how the app
 * authenticates each provider's token exchange, which profile endpoint
 * identifies the account, and the guarantee that an unresolvable profile
 * fails the connect instead of storing a colliding placeholder id.
 */

const base = "https://studio.example";
const session = { id: "user-1" };

function callbackRequest(
  platform: string,
  query: Record<string, string> = {},
  cookies: Record<string, string> = {},
): NextRequest {
  const params = new URLSearchParams({ code: "auth-code", state: "signed-state", ...query });
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return new NextRequest(`${base}/api/connect/${platform}/callback?${params}`, {
    headers: {
      host: "studio.example",
      "x-forwarded-proto": "https",
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
  });
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  getSessionUser.mockResolvedValue(session);
  verifyState.mockReturnValue({ userId: "user-1", returnUrl: "/settings/credentials" });
  getSecretKey.mockReturnValue("test-secret");
  readPlatformAppCredentials.mockResolvedValue({ clientId: "cid-1", clientSecret: "csec-1" });
  registerConnection.mockResolvedValue({ connectionId: "c1", accountIds: ["a1"] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("the OAuth callback contract", () => {
  it("authenticates the X exchange with HTTP Basic and stores the resolved profile", async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "x-token",
          refresh_token: "x-refresh",
          expires_in: 7200,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: { id: "88234239", username: "testuser" } }),
      );

    const res = await GET(
      callbackRequest("x", {}, { pkce_x: "verifier-1" }),
      { params: Promise.resolve({ platform: "x" }) },
    );

    // Call 1: the token exchange — Basic credentials, secret never in the body.
    const [tokenUrl, tokenInit] = fetchWithTimeout.mock.calls[0]!;
    expect(tokenUrl).toBe("https://api.x.com/2/oauth2/token");
    expect(tokenInit?.method).toBe("POST");
    expect((tokenInit?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("cid-1:csec-1").toString("base64")}`,
    );
    const body = String(tokenInit?.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code_verifier=verifier-1");
    expect(body).not.toContain("csec-1");
    expect(body).not.toContain("client_secret");

    // Call 2: the profile lookup with the fresh token.
    const [profileUrl, profileInit] = fetchWithTimeout.mock.calls[1]!;
    expect(profileUrl).toBe("https://api.x.com/2/users/me");
    expect((profileInit?.headers as Record<string, string>).Authorization).toBe(
      "Bearer x-token",
    );

    expect(registerConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        platform: "x",
        refreshTokenEnc: "enc:x-refresh",
        accounts: [{ platformAccountId: "88234239", handle: "testuser" }],
      }),
    );
    expect(res.headers.get("location")).toContain("connected=x");
  });

  it("sends Reddit's required User-Agent and keeps the secret out of the body", async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(jsonResponse({ access_token: "r-token", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ id: "t2_abc", name: "redditor" }));

    await GET(callbackRequest("reddit", {}, { pkce_reddit: "v" }), {
      params: Promise.resolve({ platform: "reddit" }),
    });

    const [, tokenInit] = fetchWithTimeout.mock.calls[0]!;
    const headers = tokenInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("cid-1:csec-1").toString("base64")}`,
    );
    expect(headers["User-Agent"]).toContain("HilbrasStudio");
    expect(String(tokenInit?.body)).not.toContain("csec-1");

    expect(registerConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        accounts: [{ platformAccountId: "t2_abc", handle: "redditor" }],
      }),
    );
  });

  it("fails the connect with profile_unavailable instead of storing an unknown id", async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(jsonResponse({ access_token: "x-token" }))
      .mockResolvedValueOnce(jsonResponse({}, 503)); // profile endpoint down

    const res = await GET(callbackRequest("x", {}, { pkce_x: "v" }), {
      params: Promise.resolve({ platform: "x" }),
    });

    expect(registerConnection).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain("error=profile_unavailable");
  });

  it("runs the Facebook GET exchange without a PKCE verifier and stores the Graph id", async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(jsonResponse({ access_token: "fb-token" }))
      // The short token is upgraded to a long-lived one before the profile read.
      .mockResolvedValueOnce(jsonResponse({ access_token: "fb-long", expires_in: 5184000 }))
      .mockResolvedValueOnce(jsonResponse({ id: "fb-user-1", name: "Jane" }));

    // No pkce_facebook cookie at all — the GET exchange documents no verifier.
    const res = await GET(callbackRequest("facebook"), {
      params: Promise.resolve({ platform: "facebook" }),
    });

    const [tokenUrl] = fetchWithTimeout.mock.calls[0]!;
    expect(String(tokenUrl)).toContain("graph.facebook.com");
    expect(String(tokenUrl)).toContain("client_secret=csec-1");
    expect(String(tokenUrl)).not.toContain("code_verifier");

    expect(registerConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        accounts: [{ platformAccountId: "fb-user-1", handle: "Jane" }],
      }),
    );
    expect(res.headers.get("location")).toContain("connected=facebook");
  });

  it("still rejects a state that fails verification before touching any provider", async () => {
    verifyState.mockReturnValue(null);

    const res = await GET(callbackRequest("x", {}, { pkce_x: "v" }), {
      params: Promise.resolve({ platform: "x" }),
    });

    expect(fetchWithTimeout).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain("error=invalid_state");
  });
});
