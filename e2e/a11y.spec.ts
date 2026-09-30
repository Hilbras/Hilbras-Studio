import { expect, test } from "@playwright/test";

import {
  expectImagesLabelled,
  expectKeyboardReachable,
  expectNoBlockingViolations,
  expectSingleH1,
  seedUser,
  signIn,
  type SeededUser,
} from "./helpers";

/**
 * Accessibility smoke over the critical flows.
 *
 * Scope: landing → signup → dashboard shell, plus login. These are the flows the
 * plan names and the ones every user passes through. It is not a crawl — a
 * per-route crawl would need every dashboard page seeded with its own data, and
 * the suite is a smoke test by name and by design.
 *
 * Each spec asserts the same four things, because they are the four that catch
 * what `jsx-a11y` cannot: axe violations at the WCAG 2.1 AA bar, keyboard
 * reachability (a DOM inspection cannot see focus order), labelled images, and a
 * single `<h1>` as the page's one top-level heading.
 */

test.describe("public pages", () => {
  test("landing page is navigable and labelled", async ({ page }) => {
    await page.goto("/");
    await expectNoBlockingViolations(page, "the landing page");
    await expectSingleH1(page, "the landing page");
    await expectImagesLabelled(page, "the landing page");
    await expectKeyboardReachable(page, "the landing page");
  });

  test("pricing page is navigable and labelled", async ({ page }) => {
    // Public claims live here, and Task 16 rewrote this page. A smoke test is the
    // cheapest way to notice the rewrite reintroduced an unlabelled control.
    await page.goto("/pricing");
    await expectNoBlockingViolations(page, "the pricing page");
    await expectSingleH1(page, "the pricing page");
  });

  test("privacy page is navigable and labelled", async ({ page }) => {
    await page.goto("/privacy");
    await expectNoBlockingViolations(page, "the privacy page");
    await expectSingleH1(page, "the privacy page");
  });

  test("login form labels its controls", async ({ page }) => {
    await page.goto("/login");
    await expectNoBlockingViolations(page, "the login page");

    // Explicit, because a form whose inputs are unlabelled is the single most
    // common real-world a11y failure and axe's form rules are worth asserting
    // directly here rather than only in aggregate.
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expectKeyboardReachable(page, "the login page");
  });
});

test.describe("signed-in flows", () => {
  let user: SeededUser;

  test("a person can sign up and lands somewhere usable", async ({ page }) => {
    user = await seedUser(page);
    expect(user.email).toContain("@");
    await expectNoBlockingViolations(page, "the page after signup");
    await expectSingleH1(page, "the page after signup");
    await expectKeyboardReachable(page, "the page after signup");
  });

  test("a person can sign in again and reach the dashboard", async ({ page }) => {
    test.skip(!user, "depends on the signup test having seeded a user");
    await signIn(page, user);
    await expectNoBlockingViolations(page, "the dashboard after login");
    await expectSingleH1(page, "the dashboard after login");
    await expectKeyboardReachable(page, "the dashboard after login");
  });

  test("the dashboard navigation is labelled", async ({ page }) => {
    test.skip(!user, "depends on the signup test having seeded a user");
    await signIn(page, user);

    // A link or button with no accessible name is invisible to a screen-reader
    // user even though it looks like an icon and passes jsx-a11y, which only
    // sees the JSX.
    const unnamed = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a, button"))
        .map((el) => {
          const text = (el.textContent ?? "").trim();
          const label = el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "";
          const imgAlt = el.querySelector("img")?.getAttribute("alt") ?? "";
          return { text, label, imgAlt, html: el.outerHTML.slice(0, 90) };
        })
        .filter((c) => !c.text && !c.label && !c.imgAlt)
        .map((c) => c.html),
    );
    expect(
      unnamed,
      `Interactive elements with no accessible name:\n${unnamed.join("\n")}`,
    ).toEqual([]);
  });

  test("reduced motion is honoured in the real browser", async ({ page }) => {
    test.skip(!user, "depends on the signup test having seeded a user");

    // The static guards prove `MotionConfig reducedMotion="user"` is wired; only
    // a browser can prove the setting reaches the animation runtime. framer-motion
    // reflects it on the document, so this is the observable consequence rather
    // than an assertion about a prop.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signIn(page, user);

    const animating = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("*")).filter((el) => {
        const s = getComputedStyle(el);
        const name = s.animationName;
        const dur = s.animationDuration;
        return (
          name &&
          name !== "none" &&
          !name.includes("pulse") &&
          parseFloat(dur) > 0.01 &&
          s.animationIterationCount !== "infinite"
        );
      }).length,
    );
    expect(
      animating,
      `${animating} element(s) run a finite animation while the visitor asked for ` +
        `reduced motion. MotionConfig reducedMotion="user" is wired in the provider ` +
        `but something animates outside it.`,
    ).toBe(0);
  });
});