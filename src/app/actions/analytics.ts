"use server";

/**
 * Thin browser-facing adapter for the analytics reads.
 *
 * The read lives in the server-only, owner-scoped `@/lib/dashboard/queries`
 * (remediation Task 17, ADR-004/ADR-008). This module exists to do one thing the
 * service deliberately does not: turn "who is asking" into a `userId`.
 *
 * The analytics page is a server component and no longer imports this — it
 * resolves the session itself and reads the service directly. The adapter
 * remains for any browser caller, and for the DTO types, which live with the
 * read so a client component can import the shape without importing the query.
 */

import { getSessionUser } from "@/lib/session";
import {
  getAnalyticsData as queryAnalyticsData,
  type AnalyticsData,
} from "@/lib/dashboard/queries";

export type {
  AnalyticsData,
  PlatformBreakdown,
  PlatformPublishStats,
  PublishedPost,
} from "@/lib/dashboard/queries";

/** No session means no data — an empty read, not an error and not a redirect. */
export async function getAnalyticsData(): Promise<AnalyticsData> {
  const session = await getSessionUser();
  if (!session) {
    return { platformBreakdown: [], publishStats: [], recentPosts: [] };
  }
  return queryAnalyticsData(session.id);
}
