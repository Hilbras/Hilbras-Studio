import { describe, expect, it } from "vitest";

import {
  sanitizePublishResult,
  sanitizePublishResults,
  sanitizeResultUrl,
} from "./result-url";

describe("sanitizeResultUrl", () => {
  it("keeps https URLs on the platform's own hosts", () => {
    expect(sanitizeResultUrl("instagram", "https://www.instagram.com/p/abc123/")).toBe(
      "https://www.instagram.com/p/abc123/"
    );
    expect(sanitizeResultUrl("telegram", "https://t.me/hilbras/42")).toBe(
      "https://t.me/hilbras/42"
    );
    expect(sanitizeResultUrl("x", "https://x.com/i/web/status/123")).toBe(
      "https://x.com/i/web/status/123"
    );
  });

  it("drops non-https schemes, off-platform hosts, and unparsable input", () => {
    expect(sanitizeResultUrl("instagram", "http://www.instagram.com/p/abc/")).toBeUndefined();
    expect(sanitizeResultUrl("instagram", "https://evil.example/p/abc")).toBeUndefined();
    expect(sanitizeResultUrl("instagram", "javascript:alert(1)")).toBeUndefined();
    expect(sanitizeResultUrl("instagram", "not a url")).toBeUndefined();
    expect(sanitizeResultUrl("instagram", undefined)).toBeUndefined();
  });

  it("has no allowance for platforms outside the publishing registry", () => {
    expect(sanitizeResultUrl("linkedin", "https://www.linkedin.com/feed/update/1")).toBeUndefined();
    expect(sanitizeResultUrl("not-a-platform", "https://x.com/1")).toBeUndefined();
  });
});

describe("sanitizePublishResult", () => {
  it("keeps a valid result intact", () => {
    expect(
      sanitizePublishResult({
        platform: "x",
        success: true,
        postId: "123",
        url: "https://x.com/i/web/status/123",
      })
    ).toEqual({
      platform: "x",
      success: true,
      postId: "123",
      url: "https://x.com/i/web/status/123",
    });
  });

  it("strips a result URL a platform response should not have produced", () => {
    const clean = sanitizePublishResult({
      platform: "instagram",
      success: true,
      url: "http://169.254.169.254/latest/meta-data",
    });
    expect(clean.url).toBeUndefined();
    expect(clean.success).toBe(true);
  });

  it("bounds oversized text fields and drops empty ones", () => {
    const clean = sanitizePublishResult({
      platform: " facebook ",
      success: false,
      postId: "   ",
      error: "x".repeat(3000),
    });
    expect(clean.platform).toBe("facebook");
    expect(clean.postId).toBeUndefined();
    expect(clean.error).toHaveLength(2000);
  });

  it("never trusts a truthy success flag", () => {
    expect(
      sanitizePublishResult({
        platform: "x",
        success: "yes" as unknown as boolean,
      })
    ).toEqual({ platform: "x", success: false });
  });
});

describe("sanitizePublishResults", () => {
  it("maps every entry", () => {
    const [first, second] = sanitizePublishResults([
      { platform: "telegram", success: true, url: "https://t.me/h/1" },
      { platform: "threads", success: false, error: "boom", url: "ftp://threads.net/x" },
    ]);
    expect(first.url).toBe("https://t.me/h/1");
    expect(second.url).toBeUndefined();
    expect(second.error).toBe("boom");
  });
});
