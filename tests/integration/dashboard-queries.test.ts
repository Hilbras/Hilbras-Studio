import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../../src/db/schema";

const { accounts, connections, postTargets, posts, users } = schema;

/**
 * `lib/dashboard/queries.ts` — the read layer the dashboard and analytics
 * screens are now held to (remediation Task 17).
 *
 * These four readers used to live in `@/app/actions/dashboard` and take no
 * arguments: each one resolved the ambient session itself. That is fine for a
 * browser action and wrong for a library — it made the reads unusable by a
 * caller that already knew whose data it wanted, which is exactly what the
 * Assistant's context builder is. So they moved, and now every one takes a
 * `userId` and puts it in the `WHERE` clause, which is the rule ADR-008
 * already established for the Runtime screens.
 *
 * The only way to know the scoping is real is to run two users against one
 * database, so the tests are almost entirely about separation, plus the three
 * places a read could otherwise be quietly wrong:
 *
 *  1. **Nothing crosses a tenant boundary.** Counts, activity, the weekly
 *     chart, and the connected-accounts list each stay with their owner — and
 *     the "Total Posts" and "Connected Accounts" cards in particular, because
 *     those are the numbers a user would not notice being wrong.
 *  2. **The `posts` counts are per *user*, not per database.** A scope that
 *     filtered on something else — say the target platform — would pass a
 *     one-platform fixture and leak in production.
 *  3. **A limit cannot be asked past the cap.** The activity clamp moved from
 *     the action into the read, so it is checked where the query is.
 *  4. **The weekly chart is this week, and it is a calendar week.** A chart
 *     that silently counts all time looks identical when everything is recent,
 *     which is the only state anyone tests in by hand.
 *  5. **The analytics page counts outcomes, not rows.** `platformBreakdown` is a
 *     share of platform-deliveries, so a post that went to two platforms is
 *     counted twice and the percentages sum to 100 — a breakdown that summed to
 *     the post count would be dividing by the wrong total.
 *  6. **A stored failure is a failure.** `publishStats` splits published from
 *     failed per platform, and the only reason that split is trustworthy is
 *     that `success` is read as exactly `true`.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let dbModule: typeof import("../../src/db");
let queries: typeof import("../../src/lib/dashboard/queries");
let originalDatabaseUrl: string | undefined;

const importForContainer = async <T>(path: string): Promise<T> =>
  import(resolve(process.cwd(), path));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  testDb = drizzle(pool, { schema });
  await migrate(testDb, { migrationsFolder: resolve(process.cwd(), "drizzle") });

  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = container.getConnectionUri();

  dbModule = await importForContainer<typeof import("../../src/db")>("src/db");
  queries = await importForContainer<typeof import("../../src/lib/dashboard/queries")>(
    "src/lib/dashboard/queries",
  );
});

afterAll(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await pool?.end();
  await dbModule?.closeDb();
  await container?.stop();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let userCount = 0;

/** A user with one X account and one Instagram account. */
async function seedUser(prefix: string): Promise<string> {
  const suffix = userCount++;
  const userId = randomUUID();
  await testDb.insert(users).values({
    id: userId,
    name: `${prefix} ${suffix}`,
    email: `${prefix}-${suffix}@example.invalid`,
    username: `${prefix}-${suffix}`,
    passwordHash: "not-a-real-hash",
  });

  const connectionId = randomUUID();
  await testDb.insert(connections).values({
    id: connectionId,
    userId,
    platform: "x",
    accessTokenEnc: "not-a-real-token",
  });

  await testDb.insert(accounts).values([
    {
      id: randomUUID(),
      userId,
      connectionId,
      platform: "x",
      accountKey: `x:${prefix}`,
      handle: `x_${prefix}`,
      platformAccountId: `x-${suffix}`,
      enabled: true,
      capabilities: null,
    },
    {
      id: randomUUID(),
      userId,
      connectionId,
      platform: "instagram",
      accountKey: `instagram:${prefix}`,
      handle: `ig_${prefix}`,
      platformAccountId: `ig-${suffix}`,
      enabled: true,
      capabilities: null,
    },
  ]);

  return userId;
}

/** A post in one of the five modeled states, published `daysAgo` days back. */
async function seedPost(
  userId: string,
  over: {
    status?: "draft" | "scheduled" | "published" | "failed" | "queued";
    content?: string;
    daysAgo?: number;
    platform?: string;
    /** One target row per entry; defaults to a single `platform`. */
    platforms?: string[];
    /** Written to `posts.results` as JSON, exactly as the publish path stores it. */
    results?: unknown;
  } = {}
): Promise<string> {
  const postId = randomUUID();
  const published =
    over.status === "published"
      ? new Date(Date.now() - (over.daysAgo ?? 0) * 86_400_000)
      : null;

  await testDb.insert(posts).values({
    id: postId,
    userId,
    content: over.content ?? `post ${postId}`,
    status: over.status ?? "draft",
    publishedAt: published,
    results: over.results === undefined ? null : JSON.stringify(over.results),
  });

  await testDb.insert(postTargets).values(
    (over.platforms ?? [over.platform ?? "x"]).map((platform) => ({
      postId,
      platform,
      accountKey: null,
    }))
  );

  return postId;
}

const stat = (stats: { label: string; value: number }[], label: string) =>
  stats.find((s) => s.label === label)?.value;

// ---------------------------------------------------------------------------
// 1. Tenant separation
// ---------------------------------------------------------------------------

describe("the dashboard reads are scoped to their caller", () => {
  it("counts only the caller's posts, in every state", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");

    await seedPost(alice, { status: "published" });
    await seedPost(alice, { status: "published" });
    await seedPost(alice, { status: "scheduled" });
    await seedPost(alice, { status: "draft" });
    await seedPost(bob, { status: "published" });
    await seedPost(bob, { status: "published" });
    await seedPost(bob, { status: "published" });
    await seedPost(bob, { status: "failed" });

    const aliceStats = await queries.getDashboardStats(alice);
    const bobStats = await queries.getDashboardStats(bob);

    expect(stat(aliceStats, "Total Posts")).toBe(4);
    expect(stat(bobStats, "Total Posts")).toBe(4);

    // The headline number: 2 for Alice, 3 for Bob. If the scope were dropped
    // both would read 5 and neither would look obviously wrong.
    expect(stat(aliceStats, "Posts Published")).toBe(2);
    expect(stat(bobStats, "Posts Published")).toBe(3);

    expect(stat(aliceStats, "Scheduled")).toBe(1);
    expect(stat(bobStats, "Scheduled")).toBe(0);
  });

  it("counts only the caller's accounts, and reports each by handle", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");

    // `seedUser` gives each user two accounts, so the count is equal here by
    // construction — the assertion that matters is the third one.
    expect(stat(await queries.getDashboardStats(alice), "Connected Accounts")).toBe(2);
    expect(stat(await queries.getDashboardStats(bob), "Connected Accounts")).toBe(2);

    const aliceAccounts = await queries.getConnectedAccountsWithDetails(alice);
    const bobAccounts = await queries.getConnectedAccountsWithDetails(bob);

    expect(aliceAccounts).toHaveLength(2);
    expect(bobAccounts).toHaveLength(2);

    // A known tenant's list contains only that tenant's handles. Without the
    // scope this is four rows, two of them belonging to someone else, and the
    // Accounts page renders the handle.
    expect(aliceAccounts.map((a) => a.username).sort()).toEqual([
      `x_alice`,
      `ig_alice`,
    ].sort());
    expect(bobAccounts.map((a) => a.username).sort()).toEqual([
      `x_bob`,
      `ig_bob`,
    ].sort());
  });

  it("returns another tenant's recent activity as empty, not as their rows", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");

    const alicePost = await seedPost(alice, { content: "Alice's private draft" });
    await seedPost(bob, { content: "Bob's private draft" });

    const aliceActivity = await queries.getRecentActivity(alice, 10);
    const bobActivity = await queries.getRecentActivity(bob, 10);

    expect(aliceActivity.map((a) => a.id)).toEqual([alicePost]);
    expect(aliceActivity[0].detail).toBe("Alice's private draft");

    // A post's content is user data. Reading it through a scope that was
    // dropped is the worst failure this module could have, so it is asserted
    // as content, not just as a count.
    expect(bobActivity.map((a) => a.id)).not.toContain(alicePost);
    expect(JSON.stringify(bobActivity)).not.toContain("Alice's private draft");
  });

  it("buckets the weekly chart per user, and only from this calendar week", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");

    await seedPost(alice, { status: "published", daysAgo: 0 });
    await seedPost(alice, { status: "published", daysAgo: 0 });
    await seedPost(bob, { status: "published", daysAgo: 0 });

    // Old enough to be outside any calendar week from now. 200 days back is
    // always a different week, whatever day the suite runs on.
    await seedPost(alice, { status: "published", daysAgo: 200 });
    await seedPost(alice, { status: "published", daysAgo: 200 });
    await seedPost(alice, { status: "published", daysAgo: 200 });

    // Drafts are not published and must not be charted.
    await seedPost(alice, { status: "draft" });

    const aliceWeek = await queries.getWeeklyChartData(alice);
    const bobWeek = await queries.getWeeklyChartData(bob);

    // Always seven buckets, Monday first, whatever day this runs.
    expect(aliceWeek.map((p) => p.day)).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
    ]);

    const aliceTotal = aliceWeek.reduce((n, p) => n + p.posts, 0);
    const bobTotal = bobWeek.reduce((n, p) => n + p.posts, 0);

    // 2 this week, not 5: the three posts from 200 days ago are outside the
    // window, and the draft never counted. Bob's 1 is his alone.
    expect(aliceTotal).toBe(2);
    expect(bobTotal).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. The activity limit
// ---------------------------------------------------------------------------

describe("recent activity cannot be asked past the cap", () => {
  it("returns the requested number, and clamps everything else to the default", async () => {
    const alice = await seedUser("alice");
    for (let i = 0; i < 12; i++) await seedPost(alice);

    expect(await queries.getRecentActivity(alice, 3)).toHaveLength(3);

    // Past the cap, and of the wrong type entirely. Both fall back to 5
    // rather than being passed to `.limit()` — the clamp moved here from the
    // action module, so it has to hold for every caller and not only the ones
    // that remembered to apply it.
    expect(await queries.getRecentActivity(alice, 5000)).toHaveLength(5);
    expect(await queries.getRecentActivity(alice, 0)).toHaveLength(5);
    expect(
      await queries.getRecentActivity(alice, "everything" as unknown as number)
    ).toHaveLength(5);
    expect(await queries.getRecentActivity(alice)).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// 3. The reads are honest about state
// ---------------------------------------------------------------------------

describe("the dashboard describes what actually happened", () => {
  it("labels each post by its own state, and truncates long content", async () => {
    const alice = await seedUser("alice");

    const long = "x".repeat(200);
    await seedPost(alice, { status: "published", content: long });
    await seedPost(alice, { status: "scheduled" });
    await seedPost(alice, { status: "failed" });
    await seedPost(alice, { status: "draft" });

    const byAction = new Map(
      (await queries.getRecentActivity(alice, 10)).map((a) => [a.action, a])
    );

    expect([...byAction.keys()].sort()).toEqual([
      "Draft saved",
      "Post published",
      "Post scheduled",
      "Publish failed",
    ]);

    // 80 characters plus an ellipsis. The detail string is fed to the
    // Assistant's system prompt, so an unbounded one is both a layout break
    // and a needless amount of the user's content in a prompt.
    const published = byAction.get("Post published")!;
    expect(published.detail).toHaveLength(81);
    expect(published.detail.endsWith("…")).toBe(true);

    // The platform comes from the post's own target row, not from a column on
    // the post — the string that `posts.platforms` used to hold is gone.
    const scheduled = [...byAction.values()].find(
      (a) => a.action === "Post scheduled"
    )!;
    expect(scheduled.platform).toBe("x");
  });

  it("reports a change against a real previous window, and '—' when there is none", async () => {
    const alice = await seedUser("alice");

    // No previous-week publishes: the denominator is zero, which is a division
    // that must not become `Infinity%` or `NaN%` in a UI card.
    await seedPost(alice, { status: "published", daysAgo: 1 });
    const first = await queries.getDashboardStats(alice);
    const published = first.find((s) => s.label === "Posts Published")!;
    expect(published.change).toBe("+100%");
    expect(published.positive).toBe(true);

    // A user who has published nothing at all is the other half of that
    // branch: no change, not a fake 100%.
    const bob = await seedUser("bob");
    const bobStats = await queries.getDashboardStats(bob);
    const bobPublished = bobStats.find((s) => s.label === "Posts Published")!;
    expect(bobPublished.change).toBe("—");
    expect(bobPublished.value).toBe(0);
  });

  it("returns empty for a user with nothing, rather than a placeholder", async () => {
    const nobody = await seedUser("nobody");

    const stats = await queries.getDashboardStats(nobody);
    expect(stats).toHaveLength(4);
    // The three post counts are zero. The fourth is not — the fixture gives
    // every user two accounts — and the point of the assertion is that the
    // *post* numbers are zero rather than omitted or faked.
    expect(stats.filter((s) => s.label !== "Connected Accounts").every((s) => s.value === 0)).toBe(
      true
    );
    expect(stat(stats, "Connected Accounts")).toBe(2);

    expect(await queries.getRecentActivity(nobody)).toEqual([]);
    // Two accounts, not zero: the fixture connects them. What is asserted is
    // that the list is the caller's own two and nobody else's rows.
    expect(
      (await queries.getConnectedAccountsWithDetails(nobody)).map((a) => a.username).sort()
    ).toEqual(["ig_nobody", "x_nobody"]);

    // Seven zero buckets, not an empty series: an empty chart and a chart of
    // zeroes are different claims about the week.
    const week = await queries.getWeeklyChartData(nobody);
    expect(week).toHaveLength(7);
    expect(week.every((p) => p.posts === 0)).toBe(true);
  });

  it("reports a missing target as 'unknown' rather than dropping the post", async () => {
    const alice = await seedUser("alice");
    const orphan = await seedPost(alice);
    // A post with no target row is the state the scheduler refuses to publish
    // ("Post has no target platforms"). The activity feed should still list it:
    // a post that silently vanishes from the user's own history is worse than
    // one labelled with an unknown platform.
    await testDb.delete(postTargets).where(eq(postTargets.postId, orphan));

    const activity = await queries.getRecentActivity(alice, 5);
    expect(activity.map((a) => a.id)).toEqual([orphan]);
    expect(activity[0].platform).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 4. Analytics
// ---------------------------------------------------------------------------

describe("the analytics page describes one user's publishing", () => {
  it("reads only the caller's published posts", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");

    await seedPost(alice, {
      status: "published",
      platform: "x",
      content: "Alice A",
      daysAgo: 1,
    });
    await seedPost(alice, {
      status: "published",
      platform: "instagram",
      content: "Alice B",
      daysAgo: 0,
    });
    // Not published, so not analytics: a draft and a failed post are not
    // something that went out.
    await seedPost(alice, { status: "draft" });
    await seedPost(alice, { status: "failed" });

    await seedPost(bob, { status: "published", platform: "x" });
    const bobSecond = await seedPost(bob, { status: "published", platform: "x" });
    await seedPost(bob, { status: "published", platform: "telegram" });

    const aliceData = await queries.getAnalyticsData(alice);
    const bobData = await queries.getAnalyticsData(bob);

    // Content again, not just counts: `recentPosts.text` is the post body,
    // rendered straight onto the user's own screen, so Bob's posts must not
    // appear in Alice's data under any field. Newest first, so "Alice B" (today)
    // leads and "Alice A" (yesterday) follows.
    expect(aliceData.recentPosts.map((p) => p.text)).toEqual(["Alice B", "Alice A"]);
    expect(JSON.stringify(aliceData)).not.toContain(bobSecond);
    expect(aliceData.platformBreakdown.map((b) => b.name).sort()).toEqual([
      "Instagram",
      "X",
    ]);

    // Two X and one Telegram for Bob: without the scope Alice would read three
    // rows and 100% X, which is a plausible-looking page.
    expect(bobData.recentPosts).toHaveLength(3);
    expect(
      bobData.platformBreakdown.find((b) => b.name === "X")?.value
    ).toBe(67);
  });

  it("counts a multi-platform post once per platform, and the shares sum to 100", async () => {
    const alice = await seedUser("alice");

    // Three deliveries from two posts.
    await seedPost(alice, { status: "published", platforms: ["x", "instagram"] });
    await seedPost(alice, { status: "published", platforms: ["x"] });

    const { platformBreakdown } = await queries.getAnalyticsData(alice);

    const byName = new Map(platformBreakdown.map((b) => [b.name, b.value]));
    expect(byName.get("X")).toBe(67);
    expect(byName.get("Instagram")).toBe(33);

    // The breakdown is a share of *deliveries*, not of posts. Dividing by the
    // post count instead would give 50/50 here and still look like a chart.
    expect(platformBreakdown.reduce((n, b) => n + b.value, 0)).toBe(100);
  });

  it("splits published from failed using the stored results", async () => {
    const alice = await seedUser("alice");

    await seedPost(alice, {
      status: "published",
      platforms: ["x", "instagram"],
      results: [
        { platform: "x", success: true, url: "https://x.com/i/status/1" },
        { platform: "instagram", success: false, error: "rate limited" },
      ],
    });

    const { publishStats, recentPosts } = await queries.getAnalyticsData(alice);
    const byPlatform = new Map(publishStats.map((s) => [s.platform, s]));

    expect(byPlatform.get("X")).toEqual({ platform: "X", published: 1, failed: 0 });
    expect(byPlatform.get("Instagram")).toEqual({
      platform: "Instagram",
      published: 0,
      failed: 1,
    });

    // The permalink is the one captured at publish time, and it is taken from a
    // successful result only.
    expect(recentPosts[0].url).toBe("https://x.com/i/status/1");
    expect(recentPosts[0].platformCount).toBe(2);
  });

  it("never links a post to the URL of a failed attempt", async () => {
    const alice = await seedUser("alice");

    // The only result this post has is a *failure*, and the failure carries a
    // URL — which is what a platform that created the post and then failed the
    // upload actually returns. Linking to it would send the user to a
    // half-published or private post and call it a success.
    await seedPost(alice, {
      status: "published",
      platforms: ["x", "instagram"],
      results: [
        { platform: "x", success: false, url: "https://x.com/i/status/ghost" },
        {
          platform: "instagram",
          success: false,
          error: "media rejected",
          url: "https://instagram.com/p/ghost",
        },
      ],
    });

    const { recentPosts } = await queries.getAnalyticsData(alice);
    expect(recentPosts[0].url).toBeNull();
  });

  it("takes the permalink from the successful result, not the first one", async () => {
    const alice = await seedUser("alice");

    // A post that failed on one platform and succeeded on another, with the
    // successful result *second* in the stored array. Taking the first URL
    // rather than the first successful one would show the wrong platform's
    // link, and taking the last would be right only by accident.
    await seedPost(alice, {
      status: "published",
      platforms: ["instagram", "x"],
      results: [
        { platform: "instagram", success: false, url: "https://instagram.com/p/bad" },
        { platform: "x", success: true, url: "https://x.com/i/status/good" },
      ],
    });

    const { recentPosts, publishStats } = await queries.getAnalyticsData(alice);
    expect(recentPosts[0].url).toBe("https://x.com/i/status/good");

    const byPlatform = new Map(publishStats.map((s) => [s.platform, s]));
    expect(byPlatform.get("Instagram")).toEqual({
      platform: "Instagram",
      published: 0,
      failed: 1,
    });
    expect(byPlatform.get("X")).toEqual({ platform: "X", published: 1, failed: 0 });
  });

  it("treats a success that is not exactly true as a failure", async () => {
    const alice = await seedUser("alice");

    // `success` is read as `=== true` because a connector's result is
    // sanitized before it is stored, and "truthy" here would count a string
    // `"false"` as a success. Three shapes that must all land in `failed`.
    await seedPost(alice, {
      status: "published",
      platform: "x",
      results: [{ platform: "x", success: "true" }],
    });
    await seedPost(alice, {
      status: "published",
      platform: "x",
      results: [{ platform: "x" }],
    });

    const { publishStats } = await queries.getAnalyticsData(alice);
    const x = publishStats.find((s) => s.platform === "X")!;
    expect(x).toEqual({ platform: "X", published: 0, failed: 2 });
  });

  it("counts a post with no stored results as one success per target platform", async () => {
    const alice = await seedUser("alice");

    // Rows published before results were stored. Assuming success is the right
    // default here — the scheduler only marks a post `published` when the
    // platform accepted it — and the alternative (dropping them) would make
    // older accounts look like they published nothing.
    await seedPost(alice, { status: "published", platforms: ["x", "instagram"] });

    const { publishStats, recentPosts } = await queries.getAnalyticsData(alice);
    const byPlatform = new Map(publishStats.map((s) => [s.platform, s.published]));

    expect(byPlatform.get("X")).toBe(1);
    expect(byPlatform.get("Instagram")).toBe(1);
    // No stored result means no permalink to link to, not a fabricated one.
    expect(recentPosts[0].url).toBeNull();
  });

  it("survives a results column that is not valid JSON", async () => {
    const alice = await seedUser("alice");
    const broken = await seedPost(alice, {
      status: "published",
      platform: "x",
    });

    // `posts.results` is a JSON string written by the publish path; a row that
    // somehow holds something else must not take the whole page down, because
    // an analytics page that 500s is worse than one missing a permalink.
    await testDb
      .update(posts)
      .set({ results: "{not json" })
      .where(eq(posts.id, broken));

    const data = await queries.getAnalyticsData(alice);
    expect(data.recentPosts.map((p) => p.id)).toEqual([broken]);
    expect(data.recentPosts[0].url).toBeNull();
  });

  it("returns empty shapes for a user who has published nothing", async () => {
    const nobody = await seedUser("nobody");

    const data = await queries.getAnalyticsData(nobody);
    expect(data).toEqual({
      platformBreakdown: [],
      publishStats: [],
      recentPosts: [],
    });
  });

  it("shows at most five recent posts, newest first", async () => {
    const alice = await seedUser("alice");

    for (let i = 0; i < 8; i++) {
      await seedPost(alice, { status: "published", daysAgo: i, content: `post ${i}` });
    }

    const { recentPosts } = await queries.getAnalyticsData(alice);
    expect(recentPosts).toHaveLength(5);
    // Newest first: day 0 was published most recently.
    expect(recentPosts.map((p) => p.text)).toEqual([
      "post 0",
      "post 1",
      "post 2",
      "post 3",
      "post 4",
    ]);
  });
});
