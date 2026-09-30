"use server";

/**
 * Thin browser-facing adapter for the dashboard reads.
 *
 * The reads live in the server-only, owner-scoped `@/lib/dashboard/queries`
 * (remediation Task 17, ADR-004/ADR-008). This module exists to do one thing
 * the service deliberately does not: turn "who is asking" into a `userId`.
 *
 * Nothing here queries anything. If a caller needs these numbers it can reach
 * the service directly, passing the user id it already has — which is what the
 * Assistant's context builder does, and what the analytics page does now that
 * it is a server component with a session in hand.
 */

import { getSessionUser } from "@/lib/session";
import {
  getConnectedAccountsWithDetails as queryConnectedAccounts,
  getDashboardStats as queryDashboardStats,
  getRecentActivity as queryRecentActivity,
  getWeeklyChartData as queryWeeklyChartData,
} from "@/lib/dashboard/queries";

export type {
  ActivityItem,
  ConnectedAccountInfo,
  DashboardStat,
  WeeklyChartPoint,
} from "@/lib/dashboard/queries";

/** No session means no data — an empty read, not an error and not a redirect. */
export async function getDashboardStats() {
  const session = await getSessionUser();
  if (!session) return [];
  return queryDashboardStats(session.id);
}

export async function getRecentActivity(limit = 5) {
  const session = await getSessionUser();
  if (!session) return [];
  return queryRecentActivity(session.id, limit);
}

export async function getWeeklyChartData() {
  const session = await getSessionUser();
  if (!session) return [];
  return queryWeeklyChartData(session.id);
}

export async function getConnectedAccountsWithDetails() {
  const session = await getSessionUser();
  if (!session) return [];
  return queryConnectedAccounts(session.id);
}
