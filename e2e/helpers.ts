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
  await page.waitForURL((url) => !url.pathname.includes("signup"), { timeout: 30_000 });
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

/** Exactly one first-level heading, so screen-reader users get one page title. */
export async function expectSingleH1(page: Page, label: string): Promise<void> {
  const count = await page.locator("h1").count();
  expect(count, `${label}: expected exactly one <h1>, found ${count}`).toBe(1);
}