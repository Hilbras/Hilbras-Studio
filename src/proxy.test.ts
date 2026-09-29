import { describe, expect, it } from "vitest";

import { ROUTE_GUARDS, config } from "./proxy";

/**
 * v0.9.5 (Phase 8): the proxy's matcher and its route lists are the same fact
 * written twice, and Phase 7 proved that is a bug waiting to happen.
 *
 * `config.matcher` is extracted from the file by static analysis, so it cannot be
 * derived from `PROTECTED` — the build fails if you try. That leaves two lists,
 * and the release that added the Runtime screens edited one of them: `/runtime`,
 * `/runs`, `/goals`, and `/approvals` were guarded by the page layout's own
 * session check but never reached the middleware, so the edge redirect and the
 * auth-POST throttle silently did not apply to the four screens the release was
 * about.
 *
 * Nothing failed loudly, which is the whole reason this test exists. A page that
 * checks its own session is *not* unprotected — it just behaves differently from
 * its neighbours, which is the kind of difference nobody reviews because there
 * is no bug report.
 */
describe("the middleware matcher", () => {
  const matcher: string[] = config.matcher;
  /** `/runtime/:path*` is how the matcher says "this route and everything under it". */
  const covers = (route: string): boolean => matcher.includes(`${route}/:path*`);

  it("runs for every route that requires a session", () => {
    // Reported as a diff rather than a count, so adding a route to one list and
    // forgetting the other names the route instead of just failing a number.
    const missing = ROUTE_GUARDS.PROTECTED.filter((route) => !covers(route));
    expect(missing).toEqual([]);
  });

  it("runs for the auth pages, so a dead session is cleared before they render", () => {
    // `AUTH_PAGES` is not optional coverage. Without it, a signed-but-revoked
    // cookie is only noticed after `/login` has rendered, and the two layers
    // bounce the browser between `/login` and `/dashboard` forever — which is
    // what the `reauth=1` branch in this file exists to break.
    const missing = ROUTE_GUARDS.AUTH_PAGES.filter((page) => !matcher.includes(page));
    expect(missing).toEqual([]);
  });

  it("matches the four Runtime screens Phase 7 added", () => {
    // Spelled out individually rather than folded into the check above. These are
    // the four that drifted, and a regression here should say which route, not
    // report that some route is absent.
    for (const route of ["/runtime", "/runs", "/goals", "/approvals"]) {
      expect(covers(route), `${route} is not matched by the middleware`).toBe(true);
    }
  });

  it("keeps /dashboard guarded, which a stale bookmark depends on", () => {
    // v0.9.0 made `/dashboard` a permanent redirect to `/runtime` and it now reads
    // nothing, so it does not strictly need guarding. It stays in `PROTECTED` so
    // an unauthenticated request is sent to `/login` in one hop, rather than
    // being served the redirect first and reaching `/login` by way of `/runtime`.
    expect(covers("/dashboard")).toBe(true);
    expect(ROUTE_GUARDS.PROTECTED).toContain("/dashboard");
  });

  it("does not match anything outside the guarded routes", () => {
    // A matcher is not free. Anything added here runs a JWT verification on every
    // request, so the list should be the guarded routes and not more — a
    // catch-all here would be a silent tax on the whole application.
    const guarded = new Set([
      ...ROUTE_GUARDS.PROTECTED.map((route) => `${route}/:path*`),
      ...ROUTE_GUARDS.AUTH_PAGES,
      "/dashboard/:path*",
    ]);
    expect([...matcher].sort()).toEqual([...guarded].sort());
  });
});
