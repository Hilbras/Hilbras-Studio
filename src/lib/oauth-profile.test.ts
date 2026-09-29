import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchPlatformProfile, hasProfileLookup } from "./oauth-profile";

/**
 * Contract tests for the profile lookups the callback route uses to identify
 * connected accounts (remediation Task 9). Each case pins the documented
 * response shape of one provider; a shape drift breaks the test here instead
 * of storing a wrong or colliding account id.
 */
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Install a global fetch that answers by URL with a JSON body and status. */
const installFetch = (
  routes: Record<string, { status?: number; body: unknown }>,
) => {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
};

describe("profile lookup contract per provider", () => {
  it("resolves X through /2/users/me with the bearer token", async () => {
    installFetch({
      "https://api.x.com/2/users/me": {
        body: { data: { id: "88234239", name: "Test User", username: "testuser" } },
      },
    });

    const profile = await fetchPlatformProfile("x", "tok-1");
    expect(profile).toEqual({ id: "88234239", handle: "testuser" });
  });

  it("resolves Reddit through /api/v1/me with a User-Agent", async () => {
    installFetch({
      "https://oauth.reddit.com/api/v1/me": {
        body: { id: "t2_abc123", name: "spez" },
      },
    });

    const profile = await fetchPlatformProfile("reddit", "tok-2");
    expect(profile).toEqual({ id: "t2_abc123", handle: "spez" });
  });

  it("resolves LinkedIn through OIDC userinfo", async () => {
    installFetch({
      "https://api.linkedin.com/v2/userinfo": {
        body: { sub: "abc123", name: "Jane Doe" },
      },
    });

    const profile = await fetchPlatformProfile("linkedin", "tok-3");
    expect(profile).toEqual({ id: "abc123", handle: "Jane Doe" });
  });

  it("resolves TikTok through /v2/user/info", async () => {
    installFetch({
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name": {
        body: { data: { user: { open_id: "open-1", display_name: "Creator" } } },
      },
    });

    const profile = await fetchPlatformProfile("tiktok", "tok-4");
    expect(profile).toEqual({ id: "open-1", handle: "Creator" });
  });

  it("resolves YouTube through channels?mine=true", async () => {
    installFetch({
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true": {
        body: {
          items: [{ id: "UC_x5XG1OV2P6uZZ5FSM9Ttw", snippet: { title: "My Channel" } }],
        },
      },
    });

    const profile = await fetchPlatformProfile("youtube", "tok-5");
    expect(profile).toEqual({ id: "UC_x5XG1OV2P6uZZ5FSM9Ttw", handle: "My Channel" });
  });

  it("resolves Pinterest through /v5/user_account, username as id", async () => {
    installFetch({
      "https://api.pinterest.com/v5/user_account": {
        body: { username: "pinc creator" },
      },
    });

    const profile = await fetchPlatformProfile("pinterest", "tok-6");
    expect(profile).toEqual({ id: "pinc creator", handle: "pinc creator" });
  });

  it("returns null on an error status or an unexpected shape", async () => {
    installFetch({
      "https://api.x.com/2/users/me": { status: 503, body: {} },
    });
    expect(await fetchPlatformProfile("x", "tok")).toBeNull();

    installFetch({
      // Missing the documented `data` wrapper — no id, no profile.
      "https://api.x.com/2/users/me": { body: { username: "no-id" } },
    });
    expect(await fetchPlatformProfile("x", "tok")).toBeNull();
  });

  it("returns null instead of throwing on an unreachable host", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(fetchPlatformProfile("x", "tok")).resolves.toBeNull();
  });

  it("marks exactly the six non-Meta OAuth platforms as lookup-supported", () => {
    for (const platform of ["x", "reddit", "linkedin", "tiktok", "youtube", "pinterest"]) {
      expect(hasProfileLookup(platform)).toBe(true);
    }
    for (const platform of ["instagram", "threads", "facebook", "telegram", "nope"]) {
      expect(hasProfileLookup(platform)).toBe(false);
    }
  });
});
