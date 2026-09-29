import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  HttpResponseTooLargeError,
  HttpTimeoutError,
  fetchWithTimeout,
} from "./http";

/**
 * v0.9.5 (Phase 8): no outbound HTTP call in the codebase had a timeout.
 *
 * `fetch` waits forever by default, and publishing is sequential within a run,
 * so a platform that accepted the connection and stopped answering left the run
 * holding a claimed step and never settling. Twenty-odd call sites is too many to
 * fix by remembering, which is what the source-scanning test at the bottom of
 * this file is for.
 */
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

/**
 * A `fetch` that never answers, but *does* reject when its signal aborts.
 *
 * The second half is the part that matters. A mock that ignores `init.signal`
 * cannot be used to test a timeout at all, because the deadline is only ever
 * able to end a request through the abort path — which is the path a naive mock
 * leaves unhandled, so the test hangs rather than fails. Real `fetch` checks
 * `signal.aborted` on entry as well as listening for the event, and so does
 * this.
 *
 * The return type is kept as the mock rather than as `typeof fetch`, because
 * `globalThis.fetch = mock` narrows the local name to the real signature and
 * `.mock.calls` would stop typechecking. Assign with `installFetch` instead.
 */
type FetchMock = ReturnType<
  typeof vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>
>;

const hangingFetch = (): FetchMock =>
  vi.fn((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const fail = () =>
        reject(
          signal?.reason ??
            new DOMException("This operation was aborted", "AbortError"),
        );
      if (signal?.aborted) {
        fail();
        return;
      }
      signal?.addEventListener("abort", fail);
    }),
  );

/** A `fetch` that resolves immediately with the given body. */
const resolvingFetch = (body: unknown = { ok: true }): FetchMock =>
  vi.fn(async () =>
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    }),
  );

/** Install a mock as the global `fetch`, keeping the mock's own type reachable. */
const installFetch = (mock: FetchMock) => {
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
};

describe("a request that completes in time", () => {
  it("returns the response", async () => {
    installFetch(resolvingFetch({ data: { id: "1" } }));

    const res = await fetchWithTimeout("https://api.x.com/2/tweets");

    expect(res.ok).toBe(true);
    await expect(res.json()).resolves.toEqual({ data: { id: "1" } });
  });

  it("passes the caller's method, headers and body through", async () => {
    const fetchMock = installFetch(
      vi.fn(async () => new Response("{}")),
    );

    await fetchWithTimeout("https://api.x.com/2/tweets", {
      method: "POST",
      headers: { Authorization: "Bearer t" },
      body: JSON.stringify({ text: "hello" }),
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ text: "hello" }));
  });
});

describe("the outbound policy (Tasks 5/13)", () => {
  it("does not follow redirects — a 3xx is handed back to the caller", async () => {
    const fetchMock = installFetch(
      vi.fn(async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "http://evil.example/steal" },
        }),
      ),
    );

    const res = await fetchWithTimeout("https://graph.facebook.com/v26.0/me");

    // Outbound URLs carry access tokens; a redirect must never be replayed
    // against another host by this module.
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.redirect).toBe("manual");
    expect(res.status).toBe(302);
    expect(res.ok).toBe(false);
  });

  it("still hands the caller a working body when the response is bounded", async () => {
    installFetch(resolvingFetch({ data: { id: "2" } }));

    const res = await fetchWithTimeout("https://api.x.com/2/tweets");

    await expect(res.json()).resolves.toEqual({ data: { id: "2" } });
    expect(res.status).toBe(200);
  });

  it("cuts off a response body that exceeds the size cap", async () => {
    installFetch(
      vi.fn(async () => new Response("x".repeat(DEFAULT_MAX_RESPONSE_BYTES + 1))),
    );

    await expect(
      fetchWithTimeout("https://api.telegram.org/bot123/sendMessage"),
    ).rejects.toBeInstanceOf(HttpResponseTooLargeError);
  });
});

describe("a request that does not", () => {
  it("gives up at the deadline and says so", async () => {
    installFetch(hangingFetch());

    const pending = fetchWithTimeout("https://api.x.com/2/tweets", {}, 1_000);
    const assertion = expect(pending).rejects.toThrow(HttpTimeoutError);

    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("does not give up early", async () => {
    // The other half. A timeout that fires on the first tick is not a timeout,
    // it is a failure with a timer attached.
    installFetch(hangingFetch());

    let settled = false;
    const pending = fetchWithTimeout("https://api.x.com/2/tweets", {}, 1_000).catch(
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  it("names the platform, not the token", async () => {
    // Outbound URLs carry `?access_token=…`. An error built from the full URL
    // would put a live credential into a user-facing string and a support
    // ticket, and a timeout is exactly the error people paste into one.
    installFetch(hangingFetch());
    const url = "https://graph.instagram.com/v25.0/me?access_token=super-secret";

    const pending = fetchWithTimeout(url, {}, 100);
    // The handler is attached *before* the clock moves. Rejecting the promise and
    // only then reaching for `.catch` leaves a window in which the rejection is
    // genuinely unhandled — a real defect in a test of a real error path, not a
    // cosmetic one, and one that vitest correctly reports as an unhandled error.
    const settled = pending.then(
      () => undefined,
      (error: Error) => error,
    );

    await vi.advanceTimersByTimeAsync(100);
    const error = (await settled) as HttpTimeoutError;

    expect(error).toBeInstanceOf(HttpTimeoutError);
    expect(error.message).toContain("graph.instagram.com");
    expect(error.message).not.toContain("super-secret");
    // The full URL is still available on the error, for a log written by
    // someone who has decided a token in a log is a trade they will make.
    expect(error.url).toBe(url);
  });

  it("uses a deadline that is generous but finite", () => {
    // A number, not a comment. If this became `Infinity`, or someone removed
    // the default argument so every call site could pass `undefined`, the
    // outbound-fetches test below would still pass and the protection would be
    // gone.
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_TIMEOUT_MS)).toBe(true);
    // Long enough for a large video upload on a slow connection, short enough
    // that a hung socket is a failed publish rather than a stuck run.
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it("clears its timer, so a settled request holds nothing open", async () => {
    // Without the `finally`, every publish would keep a Node handle alive for
    // the full fifteen seconds after it had already answered.
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    installFetch(resolvingFetch());

    await fetchWithTimeout("https://api.x.com/2/tweets", {}, 60_000);

    expect(clearSpy).toHaveBeenCalled();
    // Vitest fails a test that leaves fake timers pending; asserting the count
    // as well makes the reason for that behaviour legible here.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a caller who brought their own deadline", () => {
  it("is still honoured", async () => {
    // Composed, not replaced. A caller with a shorter deadline must win, or
    // `fetchWithTimeout` would be a way of extending a request past the limit
    // its own author set.
    installFetch(hangingFetch());
    const controller = new AbortController();

    const pending = fetchWithTimeout(
      "https://api.x.com/2/tweets",
      { signal: controller.signal },
      60_000,
    );
    controller.abort();

    await expect(pending).rejects.toThrow();
  });

  it("is not masked as a timeout when it fires", async () => {
    // The caller's abort is a different failure from ours and must not be
    // reported as "the platform did not respond".
    installFetch(hangingFetch());
    const controller = new AbortController();

    const pending = fetchWithTimeout("https://api.x.com/2/tweets", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.not.toThrow(HttpTimeoutError);
  });

  it("is not sent already aborted", async () => {
    // A signal that was aborted before the call must abort immediately rather
    // than waiting out this module's own deadline first.
    const fetchMock = installFetch(hangingFetch());
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchWithTimeout("https://api.x.com/2/tweets", {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    // Asserted through the mock's own record rather than through
    // `globalThis.fetch`, which is narrowed to the real `fetch` type by the
    // assignment above and so has no `.mock` to read.
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});

/**
 * The guard that keeps the fix from eroding.
 *
 * Hand-editing twenty call sites to add `signal` is a change that is correct
 * today and half-finished in six months. This fails the moment a new outbound
 * call is written without a deadline — which is the moment it matters, and long
 * before anyone notices a stuck run in production.
 */
describe("every outbound call in the app is bounded", () => {
  /** Directories that legitimately call `fetch` without a deadline. */
  const EXEMPT: ReadonlySet<string> = new Set([
    // The one place a timeout is implemented, and the test itself.
    "src/lib/http.ts",
    "src/lib/http.test.ts",
  ]);

  it("no module calls fetch() directly", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles("src")) {
      const relative = file.replace(`${process.cwd()}/`, "");
      if (EXEMPT.has(relative)) continue;

      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        // `globalThis.fetch` and `vi.fn()` mocks are the test harness, not
        // outbound traffic. A real call is `fetch(` reached by an expression.
        const isCall = /(?<![\w.])fetch\s*\(/.test(line);
        const isHarness =
          /globalThis\.fetch|vi\.fn|mock|spyOn/.test(line) ||
          file.endsWith(".test.ts");
        if (isCall && !isHarness) {
          offenders.push(`${relative}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    // Reported as the offending lines, so the fix is obvious from the failure.
    expect(offenders).toEqual([]);
  });
});

/** Every `.ts` file under `root`, recursively. */
function sourceFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) found.push(path);
  }
  return found;
}
