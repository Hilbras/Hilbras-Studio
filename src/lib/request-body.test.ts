import { describe, expect, it } from "vitest";

import { HttpRequestTooLargeError, MAX_REQUEST_BYTES, readRequestBody } from "./http";

/**
 * The inbound side of the size cap (AUD-033).
 *
 * `fetchWithTimeout` already capped *response* bodies — the body we asked for.
 * This is the other direction: a route that reads `req.text()` will materialise
 * whatever a caller sends, and the Instagram webhook is unauthenticated until its
 * HMAC is checked, which happened after the read. A single oversized POST could
 * therefore spend the instance's memory before anything verified the sender.
 *
 * The property worth protecting is that the cap holds **when the sender lies**.
 * `content-length` is a request header, so a check that trusts it alone is not a
 * limit; it is a suggestion. Both paths are tested below.
 */

/** A Request whose body streams `chunkSize` bytes at a time, as `total`. */
function streamOf(total: number, chunkSize = 64 * 1024, declared?: number): Request {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, total - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
  });

  const headers = new Headers();
  if (declared !== undefined) headers.set("content-length", String(declared));

  // `duplex` is required by undici for a streaming body; without it the
  // Request constructor refuses before any of this is exercised.
  return new Request("https://example.test/webhook", {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit);
}

describe("readRequestBody", () => {
  it("reads a small body intact", async () => {
    const req = new Request("https://example.test/x", { method: "POST", body: '{"a":1}' });
    expect(await readRequestBody(req)).toBe('{"a":1}');
  });

  it("returns an empty string when there is no body", async () => {
    expect(await readRequestBody(new Request("https://example.test/x"))).toBe("");
  });

  it("reassembles a body split across many chunks", async () => {
    // The whole point of reading incrementally: a 300 KB body arrives in ~5
    // chunks and must come back byte-identical, or an HMAC computed over it is
    // computed over something else.
    const req = streamOf(300_000, 64 * 1024);
    const body = await readRequestBody(req);
    expect(body.length).toBe(300_000);
    expect(body).toBe("a".repeat(300_000));
  });

  it("refuses an oversized body declared in content-length, before reading", async () => {
    const req = streamOf(10, 1024, MAX_REQUEST_BYTES + 1);
    await expect(readRequestBody(req)).rejects.toThrow(HttpRequestTooLargeError);
  });

  it("refuses an oversized body even when content-length lies", async () => {
    // The sender claims 10 bytes and streams 3 MB. A cap that trusted the header
    // would read all 3 MB — this is the case that makes the incremental check
    // necessary rather than belt-and-braces.
    const req = streamOf(3_000_000, 128 * 1024, 10);
    await expect(readRequestBody(req)).rejects.toThrow(HttpRequestTooLargeError);
  });

  it("refuses when there is no content-length at all", async () => {
    const req = streamOf(2_500_000);
    await expect(readRequestBody(req)).rejects.toThrow(HttpRequestTooLargeError);
  });

  it("reports how much it read, and what the cap was", async () => {
    const req = streamOf(2_000_100, 1024 * 1024);
    const error = await readRequestBody(req).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpRequestTooLargeError);
    const typed = error as HttpRequestTooLargeError;
    expect(typed.maxBytes).toBe(MAX_REQUEST_BYTES);
    expect(typed.receivedBytes).toBeGreaterThan(MAX_REQUEST_BYTES);
  });

  it("accepts a body exactly at the cap", async () => {
    // Off-by-one matters: a cap of N must permit N bytes, not N-1.
    const req = streamOf(1_000, 256);
    expect(await readRequestBody(req, 1_000)).toHaveLength(1_000);
  });

  it("honours a caller-supplied cap", async () => {
    const req = streamOf(5_000, 1024);
    await expect(readRequestBody(req, 1_000)).rejects.toThrow(HttpRequestTooLargeError);
  });

  it("does not silently truncate — it refuses", async () => {
    // Truncating would be worse than failing here: the webhook's HMAC is
    // computed over the body, so a truncated body verifies against the wrong
    // bytes and the operator sees "bad signature" instead of "bad request".
    const req = streamOf(5_000, 1024);
    const result = await readRequestBody(req, 1_000).then(
      (b) => b,
      () => null,
    );
    expect(result).toBeNull();
  });
});