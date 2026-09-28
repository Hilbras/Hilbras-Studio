import { requireSessionUser } from "@/lib/session";
import { listAccounts } from "@/lib/accounts/store";
import { GoalForm, type GoalTargetView } from "@/components/runtime/goal-form";
import { listTimeZonesAction } from "@/app/actions/goals";

/**
 * `/goals/new`
 *
 * A thin page. The work is in `GoalForm` and in `createGoal`'s gate; this only
 * resolves the session and gathers what the form has to offer.
 *
 * ## Why the unselectable accounts are still passed
 *
 * `GoalForm` is given every account, not just the selectable ones, and decides
 * what to disable. Hiding the rest here would make the form's behaviour depend
 * on this page, and the same form is reused by the edit page — one of the two
 * would then show accounts the other hides, and a user editing a goal would see
 * a target they could not see they had.
 *
 * The capability check is `publish_post` rather than "any capability", because a
 * goal has to publish. An account that can read but not post is not a target,
 * and `validateGoal` would refuse it anyway — showing it here means the
 * refusal is a sentence the user has already been given.
 */
export default async function NewGoalPage() {
  const user = await requireSessionUser();

  const [accounts, timeZones] = await Promise.all([
    listAccounts(user.id),
    listTimeZonesAction(),
  ]);

  const targets: GoalTargetView[] = accounts.map((account) => {
    const canPublish = account.capabilities.includes("publish_post");

    let reason: string | undefined;
    if (!account.enabled) reason = "Switched off. Turn it on in Accounts.";
    else if (!canPublish) reason = "This account type cannot publish posts.";

    return {
      accountKey: account.accountKey,
      platform: account.platform,
      handle: account.handle,
      enabled: account.enabled,
      selectable: account.enabled && canPublish,
      ...(reason ? { reason } : {}),
    };
  });

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">New goal</h1>
        <p className="text-sm text-muted-foreground">
          Describe what you want published, pick where, and set a schedule. The
          planner works out the steps each time it fires.
        </p>
      </header>

      <GoalForm mode="create" accounts={targets} timeZones={timeZones} />
    </div>
  );
}
