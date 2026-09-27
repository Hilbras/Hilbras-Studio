import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { publishDuePosts, refreshExpiringTokens, getSessionUser } = vi.hoisted(
  () => ({
    publishDuePosts: vi.fn(),
    refreshExpiringTokens: vi.fn(),
    getSessionUser: vi.fn(),
  }),
);

vi.mock("@/lib/scheduled-posts", () => ({ publishDuePosts }));
vi.mock("@/lib/token-maintenance", () => ({ refreshExpiringTokens }));
vi.mock("@/lib/session", () => ({ getSessionUser }));

import { GET, POST } from "./route";

const url = "https://studio.example/api/cron/publish-scheduled";
const session = {
  id: "user-1",
  name: "Test User",
  email: "test@example.invalid",
  username: "test_user",
};

function request(
  headers: Record<string, string> = {},
  method = "GET",
): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      host: "studio.example",
      "x-forwarded-proto": "https",
      ...headers,
    },
  });
}

beforeEach(() => {
  process.env.APP_URL = "https://studio.example";
  process.env.CRON_SECRET = "cron-test-secret";
  publishDuePosts.mockResolvedValue({
    processed: 0,
    published: 0,
    failed: 0,
    outcomes: [],
  });
  refreshExpiringTokens.mockResolvedValue({
    scanned: 0,
    refreshed: 0,
    failed: 0,
    expired: 0,
  });
  getSessionUser.mockResolvedValue(session);
});

afterEach(() => {
  delete process.env.APP_URL;
  delete process.env.CRON_SECRET;
  vi.clearAllMocks();
});

describe("scheduled publishing route", () => {
  it("allows a valid cron GET and never falls back to a session", async () => {
    const response = await GET(
      request({ authorization: "Bearer cron-test-secret" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scope: "all-users" });
    expect(refreshExpiringTokens).toHaveBeenCalledWith();
    expect(publishDuePosts).toHaveBeenCalledWith();
    expect(getSessionUser).not.toHaveBeenCalled();
  });

  it("fails GET closed without a configured or matching secret", async () => {
    delete process.env.CRON_SECRET;
    const noConfig = await GET(request());
    expect(noConfig.status).toBe(401);
    expect(publishDuePosts).not.toHaveBeenCalled();

    process.env.CRON_SECRET = "cron-test-secret";
    getSessionUser.mockResolvedValue(session);
    const wrongSecret = await GET(
      request({ authorization: "Bearer wrong-secret" }),
    );
    expect(wrongSecret.status).toBe(401);
    expect(getSessionUser).not.toHaveBeenCalled();
    expect(publishDuePosts).not.toHaveBeenCalled();
  });

  it("requires same-origin authentication for manual POST", async () => {
    const crossOrigin = await POST(
      request({ origin: "https://evil.example" }, "POST"),
    );
    expect(crossOrigin.status).toBe(403);
    expect(publishDuePosts).not.toHaveBeenCalled();

    getSessionUser.mockResolvedValue(null);
    const noSession = await POST(
      request({ origin: "https://studio.example" }, "POST"),
    );
    expect(noSession.status).toBe(401);
    expect(publishDuePosts).not.toHaveBeenCalled();
  });

  it("scopes a same-origin authenticated POST to the session user", async () => {
    const response = await POST(
      request({ origin: "https://studio.example" }, "POST"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scope: "single-user" });
    expect(refreshExpiringTokens).toHaveBeenCalledWith(session.id);
    expect(publishDuePosts).toHaveBeenCalledWith({ userId: session.id });
  });
});
