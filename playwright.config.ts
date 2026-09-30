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
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  // `reuseExistingServer` is for local iteration only — in CI the server must be
  // the one this run started, or a stale process would be tested instead.
  webServer: process.env.E2E_SKIP_SERVER
    ? undefined
    : {
        command: `pnpm exec next dev --port ${PORT}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
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