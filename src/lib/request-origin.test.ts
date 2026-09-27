import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { isSameOriginRequest, safeReturnPath } from "./request-origin";

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest("https://studio.example/api/cron/publish-scheduled", {
    headers: {
      host: "studio.example",
      "x-forwarded-proto": "https",
      ...headers,
    },
  });
}

/**
 * `originFromHeaders` returns APP_URL verbatim when it is set, and only falls
 * back to request headers when it is not. Vitest loads `.env.local`, so a
 * developer's real APP_URL would otherwise leak into these cases and make them
 * assert against the production origin instead of the one under test.
 */
function withoutAppUrl() {
  vi.stubEnv("APP_URL", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("safeReturnPath", () => {
  it("keeps same-origin paths and query strings", () => {
    expect(safeReturnPath("/accounts?connected=threads")).toBe(
      "/accounts?connected=threads",
    );
  });

  it("reduces absolute and protocol-relative URLs to a local path", () => {
    expect(safeReturnPath("https://evil.example/steal")).toBe("/steal");
    expect(safeReturnPath("//evil.example/steal")).toBe("/steal");
  });

  it("uses the fallback for empty or unusable values", () => {
    expect(safeReturnPath(undefined, "/accounts")).toBe("/accounts");
    expect(safeReturnPath("http://[invalid", "/accounts")).toBe("/accounts");
  });
});

describe("isSameOriginRequest", () => {
  it("accepts matching Origin and Referer headers", () => {
    withoutAppUrl();
    expect(
      isSameOriginRequest(
        request({ host: "studio.example", origin: "https://studio.example" }),
      ),
    ).toBe(true);
    expect(
      isSameOriginRequest(
        request({
          host: "studio.example",
          referer: "https://studio.example/scheduler",
        }),
      ),
    ).toBe(true);
  });

  it("rejects missing, cross-origin, and malformed browser origins", () => {
    withoutAppUrl();
    expect(isSameOriginRequest(request({ host: "studio.example" }))).toBe(false);
    expect(
      isSameOriginRequest(
        request({ host: "studio.example", origin: "https://evil.example" }),
      ),
    ).toBe(false);
    expect(
      isSameOriginRequest(
        request({ host: "studio.example", origin: "not-a-url" }),
      ),
    ).toBe(false);
  });

  it("compares against APP_URL when it is configured, ignoring request headers", () => {
    // Meta requires the OAuth redirect_uri to match the registered URL exactly,
    // so a configured APP_URL is authoritative — a spoofed Host header must not
    // be able to move the expected origin.
    vi.stubEnv("APP_URL", "https://studio.example/");
    expect(
      isSameOriginRequest(
        request({
          host: "attacker.example",
          "x-forwarded-host": "attacker.example",
          origin: "https://attacker.example",
        }),
      ),
    ).toBe(false);

    expect(
      isSameOriginRequest(
        request({
          host: "attacker.example",
          "x-forwarded-host": "attacker.example",
          origin: "https://studio.example",
        }),
      ),
    ).toBe(true);
  });
});
