import type { FullConfig } from "@playwright/test";

/**
 * Compile every route the suite visits, before any test starts its clock.
 *
 * ## Why this exists
 *
 * `webServer.url` waits for the dev server's first HTTP response, which it gives
 * on `/` almost immediately. Every route after that is compiled by `next dev` on
 * its first request, and on a cold runner that is expensive: `/signup` alone
 * pulls in the form, its server action, the redirect to `/dashboard`, and then
 * the dashboard's own first render.
 *
 * Left alone, that cost lands inside whichever test happened to touch the route
 * first — so signup would exceed its timeout and fail, while the identical code
 * passed moments earlier against a warm server. That is the worst shape for a
 * test suite: it reports unreliability for a condition that is entirely
 * deterministic, and the response is to stop trusting the result.
 *
 * Warming here moves the cost to a single, named place that runs once, before
 * the per-test budgets start.
 *
 * ## What it deliberately does not do
 *
 * It does not assert anything. A setup step that can fail on a product condition
 * is a second place to look for failures, and this one is about timing only. If a
 * route is broken, the test that visits it should say so — not the warm-up.
 */

const ROUTES = ["/", "/pricing", "/privacy", "/login", "/signup"];

/** How long one route may take before we call it stuck rather than slow. */
const PER_ROUTE_TIMEOUT_MS = 120_000;

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL =
    process.env.E2E_BASE_URL ??
    `http://${process.env.E2E_HOST ?? "localhost"}:${process.env.E2E_PORT ?? 3210}`;

  for (const route of ROUTES) {
    const started = Date.now();
    try {
      const response = await fetch(new URL(route, baseURL), {
        // No redirect following: the point is to trigger the compile of the page
        // asked for, and a 307 to /runtime is itself a route worth compiling.
        redirect: "manual",
        signal: AbortSignal.timeout(PER_ROUTE_TIMEOUT_MS),
      });
      // Drain the body so the compile is not still streaming when the next
      // request arrives, which would make the warm-up itself racy.
      await response.body?.cancel().catch(() => {});
      process.stdout.write(
        `  warmed ${route.padEnd(10)} ${response.status} in ${Date.now() - started}ms\n`,
      );
    } catch (error) {
      // Logged, not thrown. The test that visits this route will fail with a
      // real error and a trace; failing here instead would replace that with a
      // setup error that names neither the route's behaviour nor the page.
      process.stdout.write(
        `  warm-up for ${route} did not complete: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }

  void config;
}