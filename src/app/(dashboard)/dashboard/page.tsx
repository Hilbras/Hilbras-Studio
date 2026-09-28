import { permanentRedirect } from "next/navigation";



/**
 * `/dashboard` → `/runtime`.
 *
 * ## Why a permanent redirect and not a duplicate page
 *
 * The old `/dashboard` was an integration-first summary: connected accounts,
 * a composer prompt bar, weekly charts. None of that is wrong, and all of it
 * answers a different question from "is the Runtime doing what I asked". Phase 7
 * moved that question to `/runtime` and rebuilt the screen around it.
 *
 * Keeping both would mean two dashboards that disagree — this one the day the
 * other is edited — and a user with the old bookmark would never find the new
 * one. A redirect is the honest version: one dashboard, and every existing link
 * lands on it.
 *
 * `permanentRedirect` rather than `redirect` so search engines and caches learn
 * the move, and so a user who bookmarks the new URL does not keep bouncing.
 */
export default function DashboardPage() {
  permanentRedirect("/runtime");
}
