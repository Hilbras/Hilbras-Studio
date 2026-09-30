/**
 * Read models for the dashboard and analytics screens.
 *
 * ## Why this module exists
 *
 * These four readers used to live in `@/app/actions/dashboard` — a `"use
 * server"` module, which is the browser-facing edge of the app. Two things were
 * wrong with that, and both are the reason this file exists (remediation
 * Task 17, ADR-004 and ADR-008).
 *
 * **A server component should not reach user data through an action module.**
 * The analytics page is a server component. It has no client boundary to
 * cross, so calling an action to read a row meant paying for a serialization
 * round trip to itself, and — worse — meant the *only* way to read these
 * numbers was the one that resolves its own session internally. Which brings
 * us to the second thing.
 *
 * **Resolving the session inside the reader is what made this unfixable from
 * the outside.** `getWeeklyChartData()` took no arguments and worked out whose
 * data to return by itself. That is a reasonable convenience for an action and
 * an unreasonable one for a library: the Assistant's context builder needed
 * the same four reads for the *same* user the request was already
 * authenticated as, and could not say so — it could only call the function and
 * hope the ambient session was the one it meant. The import from
 * `@/lib/ai` into `@/app/actions` was the visible symptom; the ambient session
 * was the actual coupling.
 *
 * So every function here takes a `userId` and puts it in the `WHERE` clause,
 * which is the rule ADR-008 already established for the Runtime screens. A
 * caller that has the wrong id asks the wrong question and gets the wrong
 * user's answer visibly, at the call site, instead of silently.
 *
 * ## The rule this establishes
 *
 * A screen reads user data through this module, and so does anything else that
 * already knows who it is acting for — the Assistant context builder being the
 * case that motivated the move.
 *
 * The analytics page's reads arrived here for the same reason and live in the
 * same module rather than a sibling of it: they read the same two tables
 * (`posts` and `post_targets`, through `getPostTargets`) and describe the same
 * user-facing numbers, so a second module would be a second place to forget the
 * scope.
 */

import "server-only";

import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { accounts, posts } from "@/db/schema";
import { getPostTargets } from "@/lib/posts/targets";
import { PLATFORM_REGISTRY, type PlatformId } from "@/lib/platforms";

export interface DashboardStat {
  label: string;
  value: number;
  suffix: string;
  change: string;
  positive: boolean;
}

export interface ActivityItem {
  id: string;
  platform: string;
  action: string;
  detail: string;
  timestamp: string;
}

/**
 * One day of publishing activity.
 *
 * Only `posts` is real: impressions/reach and likes/comments/shares are **not**
 * available from the Threads API with the scopes we request (`threads_basic`,
 * `threads_content_publish`) — reading them needs `threads_manage_insights`, so
 * they are reported as zero rather than guessed. See `getWeeklyChartData`.
 */
export interface WeeklyChartPoint {
  day: string;
  posts: number;
}

export interface ConnectedAccountInfo {
  platform: string;
  username: string | null;
  connectedAt: string;
}

/**
 * How many activity rows a caller may ask for.
 *
 * The same bound the action used to apply, now applied where the query is, so
 * it holds for every caller and not only the ones that remembered. A limit is
 * a rendering choice; the cap is a property of the read.
 */
const activityLimitSchema = z.number().int().min(1).max(50).catch(5);

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function relativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

function actionLabel(status: string): string {
  switch (status) {
    case "published":
      return "Post published";
    case "scheduled":
      return "Post scheduled";
    case "draft":
      return "Draft saved";
    case "failed":
      return "Publish failed";
    default:
      return "Activity";
  }
}

/** The four headline counts, for one user. */
export async function getDashboardStats(userId: string): Promise<DashboardStat[]> {
  const sevenDaysAgo = daysAgo(7);
  const fourteenDaysAgo = daysAgo(14);

  const [currentPublished, previousPublished, currentScheduled, totalPosts] =
    await Promise.all([
      db
        .select({ value: count() })
        .from(posts)
        .where(
          and(
            eq(posts.userId, userId),
            eq(posts.status, "published"),
            gte(posts.publishedAt, sevenDaysAgo)
          )
        )
        .then((r) => r[0]?.value ?? 0),
      db
        .select({ value: count() })
        .from(posts)
        .where(
          and(
            eq(posts.userId, userId),
            eq(posts.status, "published"),
            gte(posts.publishedAt, fourteenDaysAgo),
            lte(posts.publishedAt, sevenDaysAgo)
          )
        )
        .then((r) => r[0]?.value ?? 0),
      db
        .select({ value: count() })
        .from(posts)
        .where(and(eq(posts.userId, userId), eq(posts.status, "scheduled")))
        .then((r) => r[0]?.value ?? 0),
      db
        .select({ value: count() })
        .from(posts)
        .where(eq(posts.userId, userId))
        .then((r) => r[0]?.value ?? 0),
    ]);

  // Counts accounts, not connections: a user with three X accounts has three
  // accounts, and "3 connected accounts" is the number they recognise.
  const connectedCount = await db
    .select({ value: count() })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .then((r) => r[0]?.value ?? 0);

  const calcChange = (curr: number, prev: number) => {
    if (prev === 0) return curr > 0 ? "+100%" : "—";
    const pct = Math.round(((curr - prev) / prev) * 100);
    return pct >= 0 ? `+${pct}%` : `${pct}%`;
  };

  // Every card here is a real count from the `posts` table. Reach and
  // engagement are deliberately absent rather than estimated: they need the
  // platform insights APIs (`threads_manage_insights` etc.), which this app does
  // not request yet. Placeholder multipliers ("× 850") previously made the
  // dashboard look populated while showing invented numbers.
  return [
    {
      label: "Posts Published",
      value: currentPublished,
      suffix: "",
      change: calcChange(currentPublished, previousPublished),
      positive: currentPublished >= previousPublished,
    },
    {
      label: "Scheduled",
      value: currentScheduled,
      suffix: "",
      change: "—",
      positive: true,
    },
    {
      label: "Total Posts",
      value: totalPosts,
      suffix: "",
      change: "—",
      positive: true,
    },
    {
      label: "Connected Accounts",
      value: connectedCount,
      suffix: "",
      change: "—",
      positive: true,
    },
  ];
}

/** The most recent posts for one user, newest first. */
export async function getRecentActivity(
  userId: string,
  limit = 5
): Promise<ActivityItem[]> {
  // Clamped: anything out of range (or the wrong type) falls back to 5.
  const safeLimit = activityLimitSchema.parse(limit);

  const rows = await db
    .select()
    .from(posts)
    .where(eq(posts.userId, userId))
    .orderBy(desc(posts.createdAt))
    .limit(safeLimit);

  const targets = await getPostTargets(rows.map((r) => r.id));

  return rows.map((r) => ({
    id: r.id,
    platform: targets.get(r.id)?.[0] ?? "unknown",
    action: actionLabel(r.status),
    detail: r.content.slice(0, 80) + (r.content.length > 80 ? "…" : ""),
    timestamp: relativeTime(r.createdAt),
  }));
}

/** Published posts per day, Monday through Sunday, for one user. */
export async function getWeeklyChartData(userId: string): Promise<WeeklyChartPoint[]> {
  const today = new Date();
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - today.getDay() + 1); // Monday
  startOfWeek.setHours(0, 0, 0, 0);

  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);

  const rows = await db
    .select()
    .from(posts)
    .where(
      and(
        eq(posts.userId, userId),
        eq(posts.status, "published"),
        gte(posts.publishedAt, startOfWeek),
        lte(posts.publishedAt, endOfWeek)
      )
    );

  const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const buckets: Record<string, { posts: number }> = {};
  for (const d of dayNames) buckets[d] = { posts: 0 };

  for (const row of rows) {
    if (!row.publishedAt) continue;
    const dayIdx = row.publishedAt.getDay();
    const dayName = dayNames[dayIdx === 0 ? 6 : dayIdx - 1];
    buckets[dayName].posts += 1;
  }

  return dayNames.map((day) => ({
    day,
    posts: buckets[day].posts,
  }));
}

/** The user's connected accounts, newest first. */
export async function getConnectedAccountsWithDetails(
  userId: string
): Promise<ConnectedAccountInfo[]> {
  // Accounts, not connections: the user recognises their accounts, and one
  // grant can back several of them.
  const rows = await db
    .select({
      platform: accounts.platform,
      username: accounts.handle,
      connectedAt: accounts.createdAt,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .orderBy(desc(accounts.createdAt));

  return rows.map((r) => ({
    platform: r.platform,
    username: r.username,
    connectedAt: r.connectedAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export interface PlatformBreakdown {
  name: string;
  value: number;
  color: string;
}

/**
 * Real publishing outcome per platform, derived from each post's stored
 * publish results.
 *
 * Note there are no likes/comments/shares here: this app only requests
 * `threads_basic` + `threads_content_publish`, and per-post metrics require the
 * insights endpoints and scopes. Numbers are omitted rather than invented.
 */
export interface PlatformPublishStats {
  platform: string;
  published: number;
  failed: number;
}

/** A published post, with the permalink captured at publish time when we have it. */
export interface PublishedPost {
  id: string;
  platform: string;
  text: string;
  date: string;
  /** Public post URL, present only when the platform returned one. */
  url: string | null;
  /** How many platforms this post went out to. */
  platformCount: number;
}

export interface AnalyticsData {
  platformBreakdown: PlatformBreakdown[];
  publishStats: PlatformPublishStats[];
  recentPosts: PublishedPost[];
}

/** Shape of one entry in `posts.results` (written by the publish path). */
interface StoredPublishResult {
  platform?: string;
  success?: boolean;
  url?: string;
  error?: string;
}

/** `posts.results` is a JSON string; anything unreadable counts as no results. */
function parseResults(raw: string | null): StoredPublishResult[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredPublishResult[]) : [];
  } catch {
    return [];
  }
}

/** "Sep 20" style date for the charts, or an em dash when unknown. */
function shortDate(value: Date | null): string {
  return value
    ? value.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "—";
}

/** Display name for a platform id: "threads" → "Threads" (registry name wins). */
function platformLabel(id: string): string {
  return (
    PLATFORM_REGISTRY[id as PlatformId]?.name ??
    id.charAt(0).toUpperCase() + id.slice(1)
  );
}

const PLATFORM_COLORS: Record<string, string> = {
  instagram: "#E4405F",
  x: "#14171A",
  linkedin: "#0A66C2",
  facebook: "#1877F2",
  youtube: "#FF0000",
  tiktok: "#000000",
  threads: "#000000",
  pinterest: "#BD081C",
  reddit: "#FF4500",
  telegram: "#2AABEE",
};

/**
 * How many published rows the analytics page will read.
 *
 * Bounded so a long-lived deployment cannot make this query unbounded
 * (remediation Task 14: no unbounded result queries). The page aggregates stats
 * across every platform and shows five recent posts, so 500 published rows is
 * far past either need. It is a real ceiling rather than a page size: past it
 * the breakdown silently describes a sample, which is the trade this number
 * makes deliberately.
 */
const ANALYTICS_POST_LIMIT = 500;

/** Everything the analytics page renders, for one user. */
export async function getAnalyticsData(userId: string): Promise<AnalyticsData> {
  const publishedPosts = await db
    .select()
    .from(posts)
    .where(and(eq(posts.userId, userId), eq(posts.status, "published")))
    .orderBy(desc(posts.publishedAt))
    .limit(ANALYTICS_POST_LIMIT);

  // One query for the whole page rather than one per post.
  const targets = await getPostTargets(publishedPosts.map((p) => p.id));

  // Platform breakdown: count posts per platform
  const platformCounts: Record<string, number> = {};
  for (const post of publishedPosts) {
    for (const platform of targets.get(post.id) ?? []) {
      platformCounts[platform] = (platformCounts[platform] || 0) + 1;
    }
  }

  // The denominator is the number of *deliveries*, not the number of posts: a
  // post aimed at two platforms is one row and two shares of the pie, so the
  // percentages sum to 100. Dividing by the post count would silently produce
  // a breakdown that does not add up.
  const totalPosts = Object.values(platformCounts).reduce((a, b) => a + b, 0);
  const platformBreakdown: PlatformBreakdown[] = Object.entries(platformCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({
      name: platformLabel(name),
      value: totalPosts > 0 ? Math.round((count / totalPosts) * 100) : 0,
      color: PLATFORM_COLORS[name] || "#888888",
    }));

  // Publish outcomes per platform, taken from each post's stored results.
  const statsMap = new Map<string, PlatformPublishStats>();

  for (const post of publishedPosts) {
    const platforms = targets.get(post.id) ?? [];
    const results = parseResults(post.results);

    // Attribute each result to the platform it names. Rows published before
    // results were stored have none, so they count once per target platform.
    const outcomes: Array<{ platform: string; success: boolean }> =
      results.length > 0
        ? results.map((r) => ({
            platform: r.platform?.trim() || platforms[0] || "unknown",
            // Strictly `true`, not truthy: a connector result is sanitized
            // before it is stored, and a loose read would count the string
            // `"true"` as a publish.
            success: r.success === true,
          }))
        : platforms.map((platform) => ({ platform, success: true }));

    for (const { platform, success } of outcomes) {
      const entry = statsMap.get(platform) ?? {
        platform,
        published: 0,
        failed: 0,
      };
      if (success) entry.published += 1;
      else entry.failed += 1;
      statsMap.set(platform, entry);
    }
  }

  const publishStats: PlatformPublishStats[] = Array.from(statsMap.values())
    .sort((a, b) => b.published + b.failed - (a.published + a.failed))
    .slice(0, 6)
    .map((entry) => ({ ...entry, platform: platformLabel(entry.platform) }));

  // Most recent posts, with the permalink captured at publish time so a row can
  // link straight to the live post when the platform returned one. Only a
  // successful result's URL counts: a failed attempt's URL is not a post.
  const recentPosts: PublishedPost[] = publishedPosts.slice(0, 5).map((post) => {
    const platforms = targets.get(post.id) ?? [];
    const url = parseResults(post.results).find((r) => r.success && r.url)?.url;

    return {
      id: post.id,
      platform: platforms[0] || "unknown",
      text: post.content,
      date: shortDate(post.publishedAt),
      url: url ?? null,
      platformCount: platforms.length,
    };
  });

  return { platformBreakdown, publishStats, recentPosts };
}
