import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * Shared helpers for the accessibility smoke suite.
 *
 * ## The failure mode this is written against
 *
 * A smoke test that quietly skips is worse than no smoke test: CI goes green, the
 * plan's checkbox gets ticked, and nothing was ever checked. So every helper here
 * **fails loudly** instead. If `TEST_DATABASE_URL` is unset, `seedUser` throws
 * rather than returning a dummy — the difference between "the smoke test passed"
 * and "the smoke test did not run" should never be invisible.
 */

/**
 * Block until the page's stylesheets have actually been applied.
 *
 * A stylesheet element exists long before its rules are parsed and the cascade is
 * computed, so `waitForLoadState("networkidle")` is not enough — that waits on the
 * network, not on style resolution. This waits for the document to report a
 * stylesheet count, then for `getComputedStyle` to return a real colour on an
 * element that only has one because a class applies it.
 *
 * That second part is the part that matters: it is the observable condition the
 * assertions depend on, rather than a proxy for it.
 */
export async function waitForStyles(page: Page): Promise<void> {
  // Wait until the *utility* CSS has applied, not merely the base stylesheet.
  //
  // Two earlier versions were wrong and both failed in CI rather than locally:
  //
  // - Probing the first <button> for a background timed out on three pages. The
  //   landing page has no button until its client code mounts, and a button can
  //   legitimately be transparent before the cascade lands.
  //
  // - Waiting for `--background` to be readable was too weak. That token lives in
  //   the base stylesheet, which resolves long before Tailwind has emitted the
  //   utility rules — so axe measured the page with tokens applied and utilities
  //   missing, and reported the gold button at 2.98:1. It is the same
  //   false-contrast failure as before, just triggered by a different element.
  //
  // The condition that actually distinguishes the two states: a rule that only
  // exists in the generated utilities, applied to an element that carries it.
  // `text-gold-700` is on the pricing CTA in every build, and it cannot resolve
  // until the utility layer is present.
  await page.waitForFunction(
    () => {
      if (document.styleSheets.length === 0) return false;

      // Both layers have to be present, and a check for only one of them misses
      // exactly the failure it was added to catch. Two successive CI runs proved
      // it: a canary satisfied by the `dark:` variant let the *base* utilities
      // load a chunk later, so axe measured the landing nav's
      // `text-muted-foreground` unstyled and reported 14 contrast failures on a
      // pair that measures 6.42:1.
      const resolves = (className: string, property: "color" | "backgroundColor") => {
        const probe = document.createElement("div");
        probe.className = className;
        probe.style.display = "none";
        document.body.appendChild(probe);
        const value = getComputedStyle(probe)[property];
        probe.remove();
        return value !== "" && value !== "rgba(0, 0, 0, 0)";
      };

      return (
        // Base utility layer.
        resolves("text-muted-foreground", "color") &&
        // The `dark:` variant layer, which the gold button's colours come from.
        resolves("dark:bg-gold-300", "backgroundColor")
      );
    },
    undefined,
    { timeout: 60_000 },
  );

  // The document the assertions read must itself be settled.
  //
  // This waited on `document.title` being non-empty, which looked sufficient and
  // is not: Next.js clears the title while swapping routes, so a client-side
  // redirect can satisfy "complete" with an empty one, and axe then reports
  // `document-title` — a document state this app is never actually in. Caught by a
  // flaky run whose report showed an `alert` boundary and no title.
  //
  // The condition is the one the assertion actually depends on: a settled
  // document that still has a title, held for two consecutive checks rather than
  // one. A single sample races the very gap it is trying to close.
  await page.waitForFunction(
    () => {
      const settled = document.readyState === "complete" && document.title.trim().length > 0;
      const previous = (window as Window & { __a11ySettled?: boolean }).__a11ySettled;
      (window as Window & { __a11ySettled?: boolean }).__a11ySettled = settled;
      return settled && previous === true;
    },
    undefined,
    { timeout: 60_000 },
  );

  // Then wait for animations to finish.
  //
  // This is the third distinct cause of the same symptom, and the one that
  // survived the two CSS checks. The landing header is a `motion.header` that
  // animates `opacity: 0 → 1` over 500ms, inside a `backdrop-filter: blur()` glass
  // panel. axe composites a partially-transparent element against its backdrop, so
  // read mid-animation it reports contrast failures for text that measures ~6:1
  // once settled — on the same element, on every run, and never locally, because a
  // warm server finishes the animation before the first assertion.
  //
  // Wait for colour-changing animations to settle.
  //
  // This went through three versions, and the one that works is not the obvious
  // one. The obvious one is `document.getAnimations()`: it reports *nothing* for
  // these animations, because framer-motion drives them by writing inline styles
  // on every frame rather than through the Web Animations API. Probing a live page
  // showed exactly three registered animations, all of them the infinite `spin`
  // ones, while a card mid-stagger had `filter: blur(4px)` applied.
  //
  // So the condition is on the element's *computed* value, which is true whether
  // the animation came from WAAPI or from a library writing styles in a rAF loop.
  // `opacity` and `filter` are the two properties that change composited colour;
  // a `y` transform moves an element without altering its colour, and would make
  // this wait for transforms that legitimately never end.
  //
  // Stability, rather than "no animation is running", is the property worth
  // waiting on — an animation can start after the first sample, so a single
  // clear reading is not a settled one. The window is short enough to add nothing
  // to a warm run and long enough to span one frame at 60Hz.
  // Only elements that *carry text* need to have settled.
  //
  // Two dead ends came first, and both are worth naming because each looked
  // obviously right. Reading `getComputedStyle` waits forever: opacity and filter
  // are inherited, so a child of an animating parent reads as mid-flight even
  // after its own animation finished — 40 elements that way on this page.
  // Reading the element's own inline style then over-waits: ten 3px decorative
  // dots run an opacity loop forever, and nothing about them is ever going to
  // settle.
  //
  // Contrast is a property of rendered *text*, so the question worth asking is
  // whether any element containing text is mid-flight. A decorative dot has none,
  // and axe never reports it. That makes this both correct and short.
  //
  // The inline style is read rather than the computed one because framer-motion
  // writes it directly: `opacity: 0` while animating, and removed once finished.
  await page.waitForFunction(
    () => {
      const hasText = (el: Element) =>
        (el.textContent ?? "").trim().length > 0 &&
        Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE);

      for (const el of document.querySelectorAll<HTMLElement>("[style*='opacity'], [style*='filter']")) {
        if (!hasText(el)) continue;

        const inline = el.getAttribute("style") ?? "";
        const opacity = /opacity:\s*([\d.]+)/.exec(inline);
        if (opacity && Number(opacity[1]) > 0.05 && Number(opacity[1]) < 0.995) return false;
        const filter = /filter:\s*blur\(([\d.]+)px\)/.exec(inline);
        if (filter && Number(filter[1]) > 0.05) return false;
      }
      return true;
    },
    undefined,
    { timeout: 30_000 },
  );

  // One more frame so the settled paint is committed before axe reads it.
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
}

/** Severities that block a release. `minor`/`moderate` are reported, not failed. */
export type AxeImpact = "critical" | "serious";

export interface A11yViolation {
  id: string;
  /**
   * axe's own ImpactValue, kept as its full union rather than narrowed to
   * `AxeImpact`. The filter above decides what *blocks*; widening the type would
   * mean losing information about what was seen, and a violation whose impact is
   * `minor` is worth having in the object even when it does not fail the run.
   */
  impact: string | undefined;
  help: string;
  nodes: number;
  /** First failing target, so the message points at something actionable. */
  sample: string;
}

/**
 * Run axe against the current page and return the violations that matter.
 *
 * Filtering rather than asserting on everything: axe reports colour-contrast and
 * landmark nits that would make this suite fail constantly and get switched off.
 * A guard that cries wolf is disabled, and a disabled guard loses the real
 * findings too — the same trade as the layer guards.
 *
 * `critical` and `serious` are the two impact levels that mean a user is actually
 * blocked: an unlabelled control, a keyboard trap, text that cannot be read.
 */
export async function violations(
  page: Page,
  blocking: AxeImpact[] = ["critical", "serious"],
): Promise<A11yViolation[]> {
  // Wait for the stylesheet before measuring. Under `next dev` Tailwind emits CSS
  // on demand, so a cold runner can analyse a page whose rules have not arrived
  // yet — and axe reports the *unstyled* computed colours, which produces
  // contrast failures for elements that are fine once the CSS lands. The first CI
  // run of this suite failed exactly that way, on a button that measures 5.14:1.
  await waitForStyles(page);

  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();

  return results.violations
    .filter((v) => v.impact && blocking.includes(v.impact as AxeImpact))
    .map((v) => ({
      id: v.id,
      impact: v.impact ?? undefined,
      help: v.help,
      nodes: v.nodes.length,
      sample: v.nodes[0]?.target?.join(" ") ?? "",
    }));
}

/** Assert no blocking violations, with a message that names the page and rule. */
export async function expectNoBlockingViolations(
  page: Page,
  label: string,
  blocking: AxeImpact[] = ["critical", "serious"],
): Promise<void> {
  const found = await violations(page, blocking);
  const detail = found
    .map((v) => `  ${v.id} (${v.impact}) ×${v.nodes} — ${v.help}\n    at: ${v.sample}`)
    .join("\n");
  expect(found, `Accessibility violations on ${label}:\n${detail || "none"}`).toEqual([]);
}

export interface SeededUser {
  email: string;
  password: string;
  handle: string;
}

let counter = 0;

/**
 * Create a real user through the signup flow and return credentials.
 *
 * Going through the UI rather than inserting a row is deliberate: it means the
 * smoke test exercises the same registration path a person does, and it fails if
 * that path breaks — which is a flow the plan asks to cover. A fixture that
 * inserted a user directly would leave signup itself untested while reporting a
 * green suite.
 *
 * The handle is unique per call because `users.username` is unique, and the
 * database is shared across tests in this run.
 */
export async function seedUser(page: Page): Promise<SeededUser> {
  counter += 1;
  const suffix = `${Date.now().toString(36)}${counter}`;
  const user: SeededUser = {
    email: `a11y-${suffix}@example.com`,
    password: `Smoke-${suffix}-Aa1!`,
    handle: `a11y_${suffix}`.slice(0, 20),
  };

  await page.goto("/signup");
  // Every field, in order. The `name` field is required by the action and is not
  // obvious from the URL — the first version of this fixture filled email and
  // password only, and the form silently stayed on /signup. Filling by label
  // rather than by position is what caught it: Playwright reported which field
  // was missing instead of the test timing out on a navigation.
  // Exact, not regex: `/name/i` also matches "Username", and Playwright's strict
  // mode rejects the ambiguity rather than silently picking the first match —
  // which is the right trade. It named both fields in the failure.
  await page.getByLabel("Name", { exact: true }).fill("Smoke Tester");
  await page.getByLabel("Username", { exact: true }).fill(user.handle);
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).fill(user.password);

  // Invite code is only required when the deployment's signup policy demands it,
  // so fill it only when the field is present *and* the form is asking for it.
  const invite = page.getByLabel(/invite code/i);
  if (await invite.isVisible().catch(() => false)) {
    const code = process.env.E2E_INVITE_CODE;
    if (code) await invite.fill(code);
  }

  await page.getByRole("button", { name: /create account|sign up|register/i }).click();

  // Signup should land on the dashboard. If it does not, the remaining tests
  // would each fail with a confusing "not signed in" instead of one clear error.
  //
  // Budget sized to what this step actually costs on a cold build.
  //
  // Measured with `.next` deleted, which is what a CI runner has: the five routes
  // took 1.7s, 9.1s, 4.2s, 14.9s and 9.6s to compile, and signup still exceeded
  // 120s — because the *server action* behind the form compiles separately, on
  // first invocation, and a GET of /signup does not trigger it. The route being
  // warm and the action being compiled are two different things.
  //
  // 300s is not a fudge factor: it is the first figure at which the cold build
  // completed, and it only ever applies cold — a warm server signs up in about 15s.
  // The cost is paid once per run and buys a suite that is either green or
  // reporting a real accessibility failure, instead of one that reports timeouts.
  await page.waitForURL((url) => !url.pathname.includes("signup"), { timeout: 300_000 });

  // The URL change is not the page being ready: Next swaps the route client-side,
  // so `waitForURL` can resolve while the old DOM is still mounted.
  await page.locator("main").first().waitFor({ state: "visible", timeout: 60_000 });
  return user;
}

/** Sign in through the login form. */
export async function signIn(page: Page, user: SeededUser): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/email|identifier|handle/i).first().fill(user.email);
  await page.getByLabel(/password/i).fill(user.password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForURL((url) => !url.pathname.includes("login"), { timeout: 30_000 });

  // The URL changing is not the page being ready. Next.js swaps the route
  // client-side, so `waitForURL` can resolve while the old DOM is still mounted
  // — which is why this once counted zero <h1> on a page that has one. Waiting
  // for the app shell's own landmark is the condition that actually means
  // "rendered", rather than "navigating".
  await page.locator("main").first().waitFor({ state: "visible", timeout: 30_000 });
}

/**
 * Keyboard reachability: the first N tab stops must not be empty.
 *
 * Not an axe rule, and cheap. A page whose entire content is unreachable by Tab
 * can pass every automated check — axe inspects the DOM, not the focus order — so
 * this is the one assertion here that cannot be replaced by a static analysis of
 * the page's own markup.
 */
export async function expectKeyboardReachable(page: Page, label: string, stops = 12): Promise<void> {
  const seen: string[] = [];
  for (let i = 0; i < stops; i += 1) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const text = (el.textContent ?? "").trim().slice(0, 30);
      return `${el.tagName.toLowerCase()}${el.getAttribute("href") ?? ""}:${text}`;
    });
    if (info && !seen.includes(info)) seen.push(info);
  }
  expect(
    seen.length,
    `${label}: Tab reached ${seen.length} distinct control(s). A page nothing can ` +
      `reach by keyboard passes every DOM-level a11y check.\n${seen.join("\n")}`,
  ).toBeGreaterThan(0);
}

/** Every image needs alt text — including empty alt for decorative ones. */
export async function expectImagesLabelled(page: Page, label: string): Promise<void> {
  const missing = await page.evaluate(() =>
    Array.from(document.images)
      .filter((img) => !img.hasAttribute("alt"))
      .map((img) => img.getAttribute("src") ?? "(no src)"),
  );
  expect(missing, `${label}: images without an alt attribute:\n${missing.join("\n")}`).toEqual([]);
}

/**
 * Exactly one first-level heading, so screen-reader users get one page title.
 *
 * Waits for the heading rather than counting immediately. Counting on arrival
 * reads the DOM before Next.js has swapped the route, and this reported zero
 * `<h1>` on the runtime page — which has one. It was the one genuinely flaky test
 * in the suite and it failed on CI twice, which is the useful signal: a test that
 * is flaky on a cold runner is measuring render timing, not accessibility.
 */
export async function expectSingleH1(page: Page, label: string): Promise<void> {
  await page.locator("h1").first().waitFor({ state: "attached", timeout: 30_000 });
  const count = await page.locator("h1").count();
  expect(count, `${label}: expected exactly one <h1>, found ${count}`).toBe(1);
}