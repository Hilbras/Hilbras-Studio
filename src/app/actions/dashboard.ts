"use server";

import { eq, and, gte, lte, desc, count } from "drizzle-orm";
import { db } from "@/db";
import { posts, socialAccounts } from "@/db/schema";
import { getSessionUser } from "@/lib/session";

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

export async function getDashboardStats(): Promise<DashboardStat[]> {
  const session = await getSessionUser();
  if (!session) return [];

  const now = new Date();
  const sevenDaysAgo = daysAgo(7);
  const fourteenDaysAgo = daysAgo(14);

  const [currentPublished, previousPublished, currentScheduled, totalPosts] =
    await Promise.all([
      db
        .select({ value: count() })
        .from(posts)
        .where(
          and(
            eq(posts.userId, session.id),
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
            eq(posts.userId, session.id),
            eq(posts.status, "published"),
            gte(posts.publishedAt, fourteenDaysAgo),
            lte(posts.publishedAt, sevenDaysAgo)
          )
        )
        .then((r) => r[0]?.value ?? 0),
      db
        .select({ value: count() })
        .from(posts)
        .where(
          and(
            eq(posts.userId, session.id),
            eq(posts.status, "scheduled")
          )
        )
        .then((r) => r[0]?.value ?? 0),
      db
        .select({ value: count() })
        .from(posts)
        .where(eq(posts.userId, session.id))
        .then((r) => r[0]?.value ?? 0),
    ]);

  const connectedCount = await db
    .select({ value: count() })
    .from(socialAccounts)
    .where(eq(socialAccounts.userId, session.id))
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

export async function getRecentActivity(limit = 5): Promise<ActivityItem[]> {
  const session = await getSessionUser();
  if (!session) return [];

  const rows = await db
    .select()
    .from(posts)
    .where(eq(posts.userId, session.id))
    .orderBy(desc(posts.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    platform: r.platforms.split(",")[0] || "unknown",
    action: actionLabel(r.status),
    detail: r.content.slice(0, 80) + (r.content.length > 80 ? "…" : ""),
    timestamp: relativeTime(r.createdAt),
  }));
}

export async function getWeeklyChartData(): Promise<WeeklyChartPoint[]> {
  const session = await getSessionUser();
  if (!session) return [];

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
        eq(posts.userId, session.id),
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

export async function getConnectedAccountsWithDetails(): Promise<
  ConnectedAccountInfo[]
> {
  const session = await getSessionUser();
  if (!session) return [];

  const rows = await db
    .select({
      platform: socialAccounts.platform,
      username: socialAccounts.username,
      connectedAt: socialAccounts.connectedAt,
    })
    .from(socialAccounts)
    .where(eq(socialAccounts.userId, session.id))
    .orderBy(desc(socialAccounts.connectedAt));

  return rows.map((r) => ({
    platform: r.platform,
    username: r.username,
    connectedAt: r.connectedAt.toISOString(),
  }));
}

