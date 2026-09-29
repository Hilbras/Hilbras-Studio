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
 * `fetch`, but it cannot hang.
 *
 * The caller's `init.signal` is honoured and composed rather than replaced: a
 * request aborted by the caller's own deadline should still abort, and a caller
 * that already has an `AbortSignal` should not have it silently dropped.
 *
 * The timer is always cleared. A `setTimeout` left running after its request
 * settles keeps the Node event loop alive for the full deadline, so without the
 * `finally` every publish would hold a handle open for fifteen seconds.
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
    return await fetch(input, { ...init, signal: controller.signal });
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
