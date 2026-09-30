/**
 * Outbound HTTP with a deadline.
 *
 * ## Why every outbound call goes through here
 *
 * `fetch` has no timeout by default. A platform that accepts a connection and
 * then never answers — a hung load balancer, a rate limiter holding a request
 * open, a DNS black hole — leaves the promise pending indefinitely. In Next.js
 * that is a request that never returns and a server action that never settles.
 *
 * This matters more than usual here because publishing is *sequential within a
 * run*: the Instagram path creates a container, polls it, then publishes it, and
 * the Threads path is the same. One hung call is not one slow publish, it is a
 * run that holds a claimed step and never settles. v0.9.5 gives the claim a
 * five-minute lease so a stuck step is eventually recoverable, but recovery is
 * a safety net — the timeout is the fix.
 *
 * ## The drift this file prevents
 *
 * There are twenty-odd outbound calls across `publish.ts`, the OAuth callback,
 * `inbox.ts`, `platform-tokens.ts`, `platform-app-check.ts` and
 * `connection-health.ts`. Hand-editing each one to add `signal` is exactly the
 * kind of list that gets edited in some places. `http.test.ts` asserts that no
 * module outside this one calls `fetch` directly, so a thirteenth connector
 * cannot quietly reintroduce an unbounded request.
 */

/** The default deadline. Generous for a large video upload, short for a hang. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The default response-body cap.
 *
 * Platform and OAuth responses here are JSON documents — small by nature — so a
 * body that runs past 2 MiB is not a legitimate answer, it is a misbehaving or
 * hostile endpoint. The response is cut off rather than buffered whole.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;

/**
 * A request that outlived its deadline.
 *
 * A distinct class rather than a string match, so a caller that wants to
 * distinguish "the platform did not answer" from "the platform said no" can,
 * and so the message reaching a user is about the platform rather than about
 * this module.
 */
export class HttpTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(
      `Request to ${hostOf(url)} did not complete within ${timeoutMs}ms. ` +
        "The platform may be down or rate-limiting this account.",
    );
    this.name = "HttpTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

/** A response body that blew past its size cap before finishing. */
export class HttpResponseTooLargeError extends Error {
  readonly url: string;
  readonly maxBytes: number;

  constructor(url: string, maxBytes: number) {
    super(
      `Response from ${hostOf(url)} exceeded ${maxBytes} bytes and was cut off.`,
    );
    this.name = "HttpResponseTooLargeError";
    this.url = url;
    this.maxBytes = maxBytes;
  }
}

/**
 * Cap for an inbound request body, matching `DEFAULT_MAX_RESPONSE_BYTES`.
 *
 * A response body is capped because we asked for it. A *request* body is capped
 * because anyone can send one: an unauthenticated route that calls `req.text()`
 * will materialise whatever it is handed, so an oversized body is a cheap way to
 * spend the instance's memory.
 */
export const MAX_REQUEST_BYTES = 2_000_000;

/** An inbound request body that blew past its size cap. */
export class HttpRequestTooLargeError extends Error {
  readonly maxBytes: number;
  readonly receivedBytes: number;

  constructor(maxBytes: number, receivedBytes: number) {
    super(`Request body exceeded ${maxBytes} bytes (${receivedBytes} read).`);
    this.name = "HttpRequestTooLargeError";
    this.maxBytes = maxBytes;
    this.receivedBytes = receivedBytes;
  }
}

/**
 * Read a request body, refusing anything over `MAX_REQUEST_BYTES`.
 *
 * Checks `Content-Length` before reading *and* enforces the cap while reading.
 * Both are needed: the header is a claim by the sender, so trusting it alone
 * makes the limit decorative, and skipping it means a lying header buys unlimited
 * memory before the first chunk arrives.
 *
 * Throws rather than truncating. This matters for the webhook that uses it: the
 * HMAC is computed over the body, so a silently truncated body would be
 * verified against the wrong bytes and the failure would look like a bad
 * signature rather than a bad request.
 */
export async function readRequestBody(
  req: Request,
  maxBytes: number = MAX_REQUEST_BYTES,
): Promise<string> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpRequestTooLargeError(maxBytes, declared);
  }

  if (!req.body) return "";

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpRequestTooLargeError(maxBytes, total);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/**
 * The host, and only the host, for an error message.
 *
 * Outbound URLs here carry access tokens in the query string — `/me?fields=x
 * &access_token=…` — so an error built from the full URL would put a live
 * credential in front of a user or into a log. A timeout is exactly the kind of
 * error that gets pasted into a support ticket.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return "the platform";
  }
}

/**
 * `fetch`, but it cannot hang and it will not read forever.
 *
 * The caller's `init.signal` is honoured and composed rather than replaced: a
 * request aborted by the caller's own deadline should still abort, and a caller
 * that already has an `AbortSignal` should not have it silently dropped.
 *
 * Two policies beyond the timeout (remediation Tasks 5/13):
 *
 * - **Redirects are not followed.** `redirect: "manual"` — every URL this
 *   server calls is a known https platform or provider endpoint, and the token
 *   or the account identity lives in the query string or the POST body. A 3xx
 *   surfaces to the caller as the response it is; their existing `!res.ok`
 *   handling reports it. A caller that genuinely needs to follow redirects
 *   must opt back in explicitly (`init.redirect`), revalidating each hop.
 * - **The response body is bounded.** The body is buffered inside the same
 *   deadline and cut off past `DEFAULT_MAX_RESPONSE_BYTES`, so "the request
 *   had a timeout" cannot be quietly undone by a slow or enormous body that
 *   `res.json()` then reads without limit.
 *
 * The timer is cleared only after the body settles. A `setTimeout` left running
 * after its request settles keeps the Node event loop alive for the full
 * deadline, so the `finally` matters — and placing the body read inside the
 * timer's window is what makes the deadline a *total* one.
 */
export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const url = input instanceof Request ? input.url : input.toString();

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new HttpTimeoutError(url, timeoutMs)),
    timeoutMs,
  );

  // A caller-supplied signal has to reach the same controller, or a request
  // bound by the caller's own deadline would ignore it and only ever be limited
  // by ours.
  const callerSignal = init.signal;
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else
      callerSignal.addEventListener("abort", () => {
        controller.abort(callerSignal.reason);
      });
  }

  try {
    const res = await fetch(input, {
      redirect: "manual",
      ...init,
      signal: controller.signal,
    });

    if (!res.body) return res; // 204/304 and empty bodies — nothing to bound.

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > DEFAULT_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new HttpResponseTooLargeError(url, DEFAULT_MAX_RESPONSE_BYTES);
      }
      chunks.push(value);
    }

    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } catch (error) {
    // `controller.abort(reason)` surfaces the reason as the rejection when the
    // runtime supports abort reasons, and a bare `AbortError` when it does not.
    // Both mean the same thing here, and both would otherwise be reported to a
    // user as "fetch failed".
    if (controller.signal.aborted && !callerSignal?.aborted) {
      throw new HttpTimeoutError(url, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
