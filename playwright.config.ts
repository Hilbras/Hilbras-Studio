import { defineConfig, devices } from "@playwright/test";

/**
 * Browser accessibility smoke tests.
 *
 * ## Why this exists, and why it took so long
 *
 * `pnpm lint` runs `eslint-plugin-jsx-a11y` recommended rules, which catch a
 * component that is statically wrong — a `div` doing a button's job, an image
 * with no `alt`, a form control with no label. That is a real guard and it is in
 * CI. It is not the same thing as checking that the rendered page is
 * navigable and labelled, which is what the plan actually asks for ("browser
 * accessibility smoke tests cover critical flows").
 *
 * The gap between those two is where accessibility bugs live: an element with a
 * correct-looking `aria-label` that no longer matches its visible text, a focus
 * order that skips a control, a contrast problem axe can measure but no lint rule
 * evaluates.
 *
 * ## Why it is configured to run once, not per-route
 *
 * A route-by-route crawl would need every dashboard page seeded with its own data
 * to render meaningfully, and the pages behind auth need a signed-in session. This
 * suite therefore covers the **critical flows** the plan names — landing, signup,
 * login, and the authenticated dashboard shell — rather than every URL. That is a
 * deliberate scope limit, and the `e2e:smoke` script says so in its name.
 *
 * ## The database
 *
 * The app needs Postgres. Locally this points at the same Testcontainers instance
 * the integration suite uses when `TEST_DATABASE_URL` is set; in CI the workflow
 * starts a `postgres:16-alpine` service and exports that URL. Nothing here creates
 * schema — `pnpm db:migrate` must have run, and the suite fails loudly rather than
 * silently skipping if the database is unreachable, because a smoke test that
 * quietly passes without testing anything is worse than no smoke test.
 */
const PORT = Number(process.env.E2E_PORT ?? 3210);
// `localhost`, not `127.0.0.1`. Next 16 blocks cross-origin dev resources by
// default and considers the literal IP a different origin from the dev server's
// own host — it logs "Blocked cross-origin request to Next.js dev resource
// /_next/hmr" and the HMR socket never connects. Harmless for a11y, but it fills
// the log with warnings that look like failures.
const HOST = process.env.E2E_HOST ?? "localhost";
const baseURL = process.env.E2E_BASE_URL ?? `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // One worker: the tests share a single seeded database and a single dev server.
  // Parallelising would have them racing on the same user row.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Generous, because a cold start pays for route compilation. The first test
  // on a fresh runner triggers the dev server to compile `/`, the next `/pricing`,
  // the next `/signup` and `/dashboard` — and on a cold CI runner each of those
  // can take most of a minute on its own. The earlier 60s budget was below the
  // cost of the environment rather than a limit on the behaviour under test, so
  // it failed as a timeout instead of as an assertion. Warm, every test here runs
  // in well under 20s, so this only bites when it should.
  timeout: 330_000,
  expect: { timeout: 10_000 },
  // `html` alongside the others, and `open: "never"` so it writes the report
  // without trying to launch a browser in CI.
  //
  // This exists because the failure artifact uploaded nothing. With only
  // `list` + `github`, no `playwright-report/` directory is ever created, so
  // `actions/upload-artifact` found an empty path and the run that failed five
  // times in this series produced no readable detail — the element and the
  // computed colours were unavailable, and each diagnosis had to be rebuilt from
  // the log's one-line summary.
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : [["list"]],

  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  // Compile the suite's routes before any assertion runs.
  //
  // `webServer.url` waits for the dev server's *first* response, which it gives
  // on `/` immediately. Every route after that is compiled on first request, and
  // on a cold runner signup alone can exceed a minute — the form, its server
  // action, the redirect, and then the dashboard's first render. Left alone, that
  // cost lands inside whichever test happened to touch the route first, so the
  // suite fails as a timeout and looks flaky rather than slow.
  //
  // Warming them explicitly moves the cost into one place, before the clock that
  // the tests are measured against. It is the difference between "this suite is
  // slow" and "this suite is unreliable", and the second one is what stops anyone
  // trusting the a11y results.
  globalSetup: "./e2e/global-setup.ts",

  // `next dev`, deliberately.
  //
  // Two candidate setups were measured against the same code before choosing:
  //
  // - `next start` (production build) over plain HTTP cannot work at all. The
  //   auth cookie is set `secure` when NODE_ENV is production, and a secure
  //   cookie is dropped over http:// — so signup silently fails with "Something
  //   went wrong" and no test-visible cause. Serving TLS on a CI runner would
  //   mean generating a certificate and trusting it, which is a lot of machinery
  //   for an accessibility check.
  //
  // - `next dev` compiles CSS on demand, so a cold runner can hand the page a
  //   stylesheet that is still being generated. That is a real risk of false
  //   contrast failures, and it is why `expectNoBlockingViolations` waits for the
  //   stylesheet to be applied before measuring (see `e2e/helpers.ts`).
  //
  // The trade is dev-mode CSS against a measurement that waits for it, rather than
  // a production build that cannot complete a signup flow at all.
  //
  // `E2E_PROD=1` opts into `next start` for anyone running against a real build
  // over HTTPS. It is *not* the default, and it needs a build to have happened
  // first — the CI job does not build, so defaulting to it would fail that job
  // before a single assertion ran.
  //
  // `reuseExistingServer` is for local iteration only — in CI the server must be
  // the one this run started, or a stale process would be tested instead.
  webServer: process.env.E2E_SKIP_SERVER
    ? undefined
    : {
        command:
          process.env.E2E_PROD === "1"
            ? `pnpm exec next start --port ${PORT}`
            : `pnpm exec next dev --port ${PORT}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        // Generous, because `url` only waits for the first HTTP response. The dev
        // server answers that on `/` and then spends the next minute or two
        // compiling the routes the suite actually visits — signup is the most
        // expensive, since it pulls in the form, its server action, the redirect,
        // and then the dashboard's own first render. Waiting 180s here rather
        // than the default 60s is what lets the per-test budget cover assertions
        // instead of compilation.
        timeout: 240_000,
        env: {
          // The dev server must not inherit a developer's own .env silently and
          // then be tested against the wrong database.
          DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
          ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? "e2e-smoke-encryption-key",
          AUTH_SECRET: process.env.AUTH_SECRET ?? "e2e-smoke-auth-secret-at-least-32-chars",
          APP_URL: baseURL,
          NODE_ENV: "development",
        },
      },
});