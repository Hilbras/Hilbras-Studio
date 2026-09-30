import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

/**
 * The Instagram webhook's inbound body is bounded (AUD-033).
 *
 * This route is the one place in the app where an unauthenticated caller can make
 * the server materialise a body before anything is verified: `POST` read
 * `req.text()` and only then checked the HMAC signature. A single oversized
 * request could therefore spend the instance's memory, and the signature check
 * that would have rejected the sender had not run yet.
 *
 * The route is exercised directly rather than through a running server — the
 * property under test is the response to an oversized body, and that is decided
 * entirely inside the handler.
 */

const SECRET = "ig-app-secret";

/** A POST whose body streams `total` bytes, optionally lying about content-length. */
function post(total: number, declared?: number): Request {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const size = Math.min(64 * 1024, total - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
  const headers = new Headers();
  if (declared !== undefined) headers.set("content-length", String(declared));
  return new Request("https://example.test/api/webhooks/instagram", {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit);
}

/** A correctly signed small request, as Meta would send it. */
function signedPost(payload: string): Request {
  const signature = "sha256=" + crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return new Request("https://example.test/api/webhooks/instagram", {
    method: "POST",
    body: payload,
    headers: { "x-hub-signature-256": signature },
  });
}

beforeEach(() => {
  vi.stubEnv("INSTAGRAM_CLIENT_SECRET", SECRET);
  for (const name of ["INSTAGRAM_WEBHOOK_VERIFY_TOKEN"]) vi.stubEnv(name, undefined);
});

describe("POST /api/webhooks/instagram", () => {
  it("accepts a correctly signed small delivery", async () => {
    const res = await POST(signedPost('{"object":"instagram"}') as never);
    expect(res.status).toBe(200);
  });

  it("still rejects a bad signature on a small body", async () => {
    // The bounded read must not have weakened the existing check.
    const req = new Request("https://example.test/api/webhooks/instagram", {
      method: "POST",
      body: "{}",
      headers: { "x-hub-signature-256": "sha256=deadbeef" },
    });
    const res = await POST(req as never);
    expect(res.status).toBe(403);
  });

  it("refuses an oversized body with 413", async () => {
    const res = await POST(post(3_000_000) as never);
    expect(res.status).toBe(413);
  });

  it("refuses an oversized body even when content-length lies", async () => {
    // The header is a claim by the sender. If it were trusted alone, declaring
    // 10 bytes and streaming 3 MB would be read in full.
    const res = await POST(post(3_000_000, 10) as never);
    expect(res.status).toBe(413);
  });

  it("checks the body size before the signature, so an unauthenticated caller cannot make it allocate", async () => {
    // Both oversized and unsigned: the point is that neither gets a 403 *after*
    // being read. It must be a 413 from the size check.
    const res = await POST(post(3_000_000) as never);
    expect(res.status).toBe(413);
    expect(res.status).not.toBe(403);
  });

  it("refuses when the app secret is not configured, without reading the body", async () => {
    vi.stubEnv("INSTAGRAM_CLIENT_SECRET", undefined);
    const res = await POST(post(10) as never);
    expect(res.status).toBe(403);
  });
});