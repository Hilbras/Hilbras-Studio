"use server";

import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db";
import { posts } from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { PLATFORM_REGISTRY, type PlatformId } from "@/lib/platforms";

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

function splitPlatforms(raw: string): string[] {
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
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
};

export async function getAnalyticsData() {
  const session = await getSessionUser();
  if (!session) {
    return {
      platformBreakdown: [] as PlatformBreakdown[],
      publishStats: [] as PlatformPublishStats[],
      recentPosts: [] as PublishedPost[],
    };
  }

  const publishedPosts = await db
    .select()
    .from(posts)
    .where(
      and(eq(posts.userId, session.id), eq(posts.status, "published"))
    )
    .orderBy(desc(posts.publishedAt));

  // Platform breakdown: count posts per platform
  const platformCounts: Record<string, number> = {};
  for (const post of publishedPosts) {
    const platforms = post.platforms.split(",");
    for (const p of platforms) {
      const trimmed = p.trim();
      if (trimmed) platformCounts[trimmed] = (platformCounts[trimmed] || 0) + 1;
    }
  }

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
    const platforms = splitPlatforms(post.platforms);
    const results = parseResults(post.results);

    // Attribute each result to the platform it names. Rows published before
    // results were stored have none, so they count once per target platform.
    const outcomes: Array<{ platform: string; success: boolean }> =
      results.length > 0
        ? results.map((r) => ({
            platform: r.platform?.trim() || platforms[0] || "unknown",
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
  // link straight to the live post when the platform returned one.
  const recentPosts: PublishedPost[] = publishedPosts.slice(0, 5).map((post) => {
    const platforms = splitPlatforms(post.platforms);
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

