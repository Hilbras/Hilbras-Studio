import { AppShell } from "@/components/app-shell";
import { PLATFORMS, type Platform } from "@/components/platform-icon";
import { requireSessionUser } from "@/lib/session";
import { getConnectedPlatforms } from "@/app/actions/posts";
import { listPendingApprovals } from "@/lib/runtime/approval-store";

/**
 * The dashboard shell.
 *
 * ## Why the pending-approval count is resolved here
 *
 * The sidebar's Approvals badge is the one piece of navigation that can be
 * *asking* the user something, and a badge that is silently out of date is worse
 * than no badge — it trains people to ignore the one indicator that matters.
 *
 * So it is read here, in the layout, rather than in the sidebar. The sidebar is
 * a client component; fetching from it would mean either a second endpoint whose
 * only job is this number, or a client cache that can disagree with the page it
 * is annotating. The layout already runs on the server for every dashboard page
 * and already resolves the session, so this is one more query on a path that was
 * already open.
 *
 * `listPendingApprovals` is scoped to the session's own user in its `WHERE`
 * clause, so this count cannot include another tenant's approvals even if the
 * id were wrong.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireSessionUser();

  const [platforms, approvals] = await Promise.all([
    getConnectedPlatforms(),
    listPendingApprovals(user.id),
  ]);

  const connectedPlatforms = platforms.filter((platform): platform is Platform =>
    PLATFORMS.includes(platform as Platform),
  );

  return (
    <AppShell
      user={{
        name: user.name,
        email: user.email,
        username: user.username,
      }}
      connectedPlatforms={connectedPlatforms}
      pendingApprovals={approvals.length}
    >
      {children}
    </AppShell>
  );
}
