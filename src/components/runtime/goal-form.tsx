"use client";

import * as React from "react";
import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { cn } from "@/components/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PlatformIcon } from "@/components/platform-icon";
import {
  createGoalAction,
  updateGoalAction,
  type GoalActionState,
} from "@/app/actions/goals";
import { describeCron, parseCron } from "@/lib/goals/cron";

/** An account a goal may target, as the form needs it. */
export interface GoalTargetView {
  accountKey: string;
  platform: string;
  handle: string | null;
  enabled: boolean;
  /** False when the account is on but lacks the capability a goal needs. */
  selectable: boolean;
  /** Why it cannot be chosen, when it cannot. */
  reason?: string;
}

/**
 * The create/edit form.
 *
 * One component for both, and the reason is not brevity. `updateGoal` re-runs
 * the *whole* gate rather than only checking the fields that changed, so an
 * edit can be refused for something the user did not touch. Two forms would
 * mean two places to render that refusal and one of them would eventually be
 * the one missing it — the edit form, being the newer and rarer path, being
 * exactly the one that gets the shortcut.
 *
 * ## The schedule is a cron field, and it says so
 *
 * A cron expression is not a thing most people can read, so the field is
 * accompanied by a plain description of what it currently means. `describeCron`
 * is the module that already parses these for the scheduler and the validator;
 * reusing it means the sentence under the box and the gate that accepts the box
 * cannot disagree about what the expression does.
 *
 * ## The account list shows what cannot be chosen, and why
 *
 * Accounts that are disconnected or lack `publish_post` are rendered disabled
 * with a reason, not hidden. Hiding them means a user whose account was
 * disconnected sees a goal form that looks like it lost their account, with no
 * way to tell that it is still there and merely unusable.
 */
export function GoalForm({
  mode,
  goalId,
  accounts,
  timeZones,
  defaults,
}: {
  mode: "create" | "edit";
  goalId?: string;
  accounts: GoalTargetView[];
  timeZones: string[];
  defaults?: {
    title: string;
    statement: string;
    schedule: string;
    timeZone: string;
    targetAccounts: string[];
  };
}) {
  const router = useRouter();

  const action = mode === "create" ? createGoalAction : updateGoalAction;

  const [state, formAction, pending] = useActionState<
    GoalActionState | null,
    FormData
  >(async (prev, formData) => {
    const result = await action(prev, formData);
    // Navigating is the form's job, not the action's. The action returns the
    // goal id; where that id leads is a decision about the screen, and putting
    // a `redirect` in the action would make it impossible to reuse for an
    // inline edit that stays on the page.
    if (result.ok && result.goalId && mode === "create") {
      router.push(`/goals/${result.goalId}`);
    }
    return result;
  }, null);

  const [schedule, setSchedule] = useState(defaults?.schedule ?? "0 9 * * *");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(defaults?.targetAccounts ?? []),
  );

  // Parsed with the module the scheduler and the gate both use, so the sentence
  // under the box and the validation that accepts the box cannot disagree about
  // what the expression does. A description written from a second parser is a
  // description that is eventually wrong about the user's own schedule.
  const cron = parseCron(schedule);
  const selectable = accounts.filter((account) => account.selectable);

  function toggle(accountKey: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(accountKey)) next.delete(accountKey);
      else next.add(accountKey);
      return next;
    });
  }

  return (
    <form action={formAction} className="space-y-6">
      {goalId ? <input type="hidden" name="goalId" value={goalId} /> : null}

      <Card>
        <CardHeader>
          <CardTitle>What should this goal do?</CardTitle>
          <CardDescription>
            Written as an instruction. The planner turns it into steps each time
            the goal fires, so say what you want, not how to do it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              name="title"
              defaultValue={defaults?.title}
              placeholder="Morning product update"
              maxLength={120}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="statement">Statement</Label>
            <Textarea
              id="statement"
              name="statement"
              defaultValue={defaults?.statement}
              rows={5}
              maxLength={4000}
              required
              placeholder="Share what shipped this week, keep it under a paragraph, and mention the changelog."
            />
            <p className="text-xs text-muted-foreground">
              This is the only thing the planner is given about your intent.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Where should it go?</CardTitle>
          <CardDescription>
            A goal publishes to every account you pick. Anything not picked is
            not published to, and the plan is refused if one of them is skipped.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {accounts.length === 0 ? (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] p-3 text-sm">
              You have no connected accounts yet.{" "}
              <a href="/accounts" className="underline">
                Connect one
              </a>{" "}
              first — a goal with no target will be refused.
            </p>
          ) : (
            <div className="space-y-2">
              {accounts.map((account) => {
                const checked = selected.has(account.accountKey);
                return (
                  <label
                    key={account.accountKey}
                    className={cn(
                      "flex items-start gap-3 rounded-lg border p-3 transition-colors",
                      account.selectable
                        ? "cursor-pointer border-border hover:bg-muted/40"
                        : "border-border/50 opacity-60",
                      checked && "border-gold-500/50 bg-gold-500/[0.04]",
                    )}
                  >
                    <Checkbox
                      name="targetAccounts"
                      value={account.accountKey}
                      checked={checked}
                      disabled={!account.selectable}
                      onCheckedChange={() => toggle(account.accountKey)}
                      className="mt-0.5"
                    />
                    <PlatformIcon platform={account.platform} size={20} />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="truncate text-sm font-medium">
                        {account.handle ?? account.accountKey}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {account.platform}
                        </span>
                      </p>
                      {account.reason ? (
                        <p className="text-xs text-amber-600 dark:text-amber-400">
                          {account.reason}
                        </p>
                      ) : null}
                    </div>
                  </label>
                );
              })}
            </div>
          )}
          {selected.size > 0 ? (
            <p className="text-xs text-muted-foreground">
              {selected.size} account{selected.size === 1 ? "" : "s"} selected
              {selectable.length > selected.size
                ? `. ${selectable.length - selected.size} available.`
                : "."}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>When should it run?</CardTitle>
          <CardDescription>
            A cron expression, in the goal&apos;s own time zone.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="schedule">Schedule</Label>
              <Input
                id="schedule"
                name="schedule"
                value={schedule}
                onChange={(event) => setSchedule(event.target.value)}
                placeholder="0 9 * * 1-5"
                className="font-mono"
                spellCheck={false}
              />
              {cron.ok ? (
                <p className="text-xs text-muted-foreground">
                  {describeCron(cron.fields)}
                </p>
              ) : (
                <p className="text-xs text-red-500">{cron.error}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="timeZone">Time zone</Label>
              <Select name="timeZone" defaultValue={defaults?.timeZone ?? "UTC"}>
                <SelectTrigger id="timeZone">
                  <SelectValue placeholder="UTC" />
                </SelectTrigger>
                <SelectContent>
                  {timeZones.map((zone) => (
                    <SelectItem key={zone} value={zone}>
                      {zone}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Issues state={state} />

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" variant="gold" disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {mode === "create" ? "Create goal" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

/**
 * What the gate said.
 *
 * Every issue is listed, never the first. `validateGoal` collects all of them
 * precisely so a form can show all of them, and a form that showed one would
 * undo that — a user would save, read one problem, fix it, and save again, once
 * per problem.
 */
function Issues({ state }: { state: GoalActionState | null }) {
  if (!state) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "rounded-md border p-4 text-sm",
        state.ok
          ? "border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-600 dark:text-emerald-400"
          : "border-red-500/30 bg-red-500/[0.06] text-red-600 dark:text-red-400",
      )}
    >
      <p>{state.message}</p>
      {state.issues && state.issues.length > 0 ? (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {state.issues.map((issue, index) => (
            <li key={index}>
              {issue.message}
              {issue.target ? (
                <span className="ml-1 opacity-70">({issue.target})</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
