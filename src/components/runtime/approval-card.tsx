"use client";

import * as React from "react";
import { useActionState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, ExternalLink, Loader2, X } from "lucide-react";

import { cn } from "@/components/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import {
  decideApprovalAction,
  type DecideApprovalState,
} from "@/app/actions/runtime";
import { editableFields, APPROVAL_WINDOW_MS } from "@/lib/runtime/approvals";
import { getTool, type ToolSpec } from "@/lib/runtime/tools";
import {
  approvalDeadlineView,
  formatInstant,
  relativeTime,
} from "@/lib/runtime/view";

/**
 * The approval screen's data, as the server read it.
 *
 * A structural type rather than an import of `StepApproval` so this component
 * can be handed a projection. The fields it needs are the ones the *question*
 * is made of; `userId` and `state` are on the row for the server's benefit.
 */
export interface ApprovalView {
  id: string;
  runId: string;
  tool: string;
  targetAccount: string | null;
  input: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
}

/**
 * One question, and the two answers.
 *
 * ## The client never decides anything
 *
 * `decideApprovalAction` is the only thing this component calls, and it is the
 * only thing in the repository that may change an approval's state. The
 * component holds no copy of whether it is approved, no optimistic transition,
 * and no disabled-after-click trick. Three reasons, all of them about the
 * failure mode:
 *
 * 1. **A decision is checked at write time.** `decideApproval` re-reads the
 *    row, confirms the owner, refuses a second answer, and closes an expired
 *    window. A client that had already hidden the card would instead show an
 *    empty list, and a user who pressed Approve in two tabs would be told
 *    nothing at all.
 * 2. **The window is enforced by a write.** A countdown in the browser is
 *    advisory; the deadline is compared on the server. Rendering "expired" the
 *    instant the bar empties would be asserting something the server has not
 *    yet decided, and the button would be pressed anyway.
 * 3. **The refusal has to be visible.** `already_decided` and
 *    `approval_expired` are the two answers a user is most likely to be
 *    surprised by, and both are only knowable server-side.
 *
 * So the card reports what the server said and re-reads the list. It does not
 * perform the transition.
 *
 * ## The snapshot is the resolved input
 *
 * `input` is what was *after* `$ref` resolution, which is the whole reason the
 * approval carries its own copy. What is rendered here is exactly what will be
 * published, and an edit is an edit of real text rather than of a pointer to
 * some other step's output.
 *
 * ## Which fields are editable
 *
 * `editableFields(tool)`, read from the tool's own declaration — the same
 * function the server uses inside `applyEdit`. A card that hardcoded "text" as
 * the editable field would be a second copy of a rule that lives on the tool,
 * and the two would disagree the first time a tool added a second editable
 * field. Importing the registry into the client is safe precisely because
 * `tools.ts` is pure and holds no platform logic.
 */
export function ApprovalCard({
  approval,
  goalTitle,
}: {
  approval: ApprovalView;
  goalTitle?: string;
}) {
  const [state, formAction, pending] = useActionState<
    DecideApprovalState | null,
    FormData
  >(decideApprovalAction, null);

  const [edit, setEdit] = React.useState<Record<string, string>>({});
  const tool = getTool(approval.tool);
  const editable = new Set(tool ? editableFields(tool) : []);

  const now = React.useMemo(() => new Date(), []);
  const deadline = approvalDeadlineView(new Date(approval.expiresAt), now);
  const decided = state?.ok === true;

  // The window's own span, so the bar is a fraction of the approval the user
  // was actually given rather than of a day assumed to be 24 hours. The two are
  // the same constant today; deriving it means they cannot stop being the same.
  const total = React.useMemo(
    () =>
      new Date(approval.expiresAt).getTime() -
      new Date(approval.createdAt).getTime() ||
      APPROVAL_WINDOW_MS,
    [approval.expiresAt, approval.createdAt],
  );
  const remaining = new Date(approval.expiresAt).getTime() - now.getTime();
  const fraction = Math.max(0, Math.min(1, remaining / total));

  return (
    <form action={formAction} className="contents">
      <input type="hidden" name="approvalId" value={approval.id} />

      <Card className={deadline.overdue ? "border-red-500/40" : undefined}>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">
                <Badge variant="gold">
                  {tool?.capability ?? approval.tool}
                </Badge>
                <span className="text-base font-medium">
                  {approval.targetAccount ?? "your account"}
                </span>
              </CardTitle>
              {goalTitle ? (
                <CardDescription>
                  From <span className="font-medium">{goalTitle}</span>
                </CardDescription>
              ) : null}
            </div>
            <DeadlineBadge
              overdue={deadline.overdue}
              soon={deadline.soon}
              label={deadline.label}
            />
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          {tool?.summary ? (
            <p className="text-sm text-muted-foreground">{tool.summary}</p>
          ) : null}

          {tool ? (
            <Fields
              tool={tool}
              input={approval.input}
              editable={editable}
              edit={edit}
              onEdit={setEdit}
            />
          ) : (
            <UnknownTool name={approval.tool} />
          )}

          {deadline.overdue ? (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/[0.06] p-3 text-sm text-red-600 dark:text-red-400">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>
                This window closed {relativeTime(new Date(approval.expiresAt), now)}.
                The server will refuse an answer now, and the step fails.
              </p>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Progress
              value={fraction * 100}
              aria-label="Time left to answer"
              aria-valuetext={deadline.label}
              className={deadline.soon ? "[&>div]:bg-amber-500" : undefined}
            />
            <p className="text-xs text-muted-foreground">
              {deadline.overdue
                ? `Closed ${formatInstant(new Date(approval.expiresAt))}`
                : `Closes ${formatInstant(new Date(approval.expiresAt))}`}
            </p>
          </div>

          <Result state={state} />
        </CardContent>

        {!decided ? (
          <CardFooter className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              type="submit"
              name="decision"
              value="rejected"
              variant="outline"
              disabled={pending}
            >
              <X className="size-4" />
              Reject
            </Button>
            <Button
              type="submit"
              name="decision"
              value="approved"
              variant="gold"
              disabled={pending || deadline.overdue}
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              Approve
            </Button>
          </CardFooter>
        ) : null}
      </Card>

      {/* Submitted with the approval, so the server can merge the edit onto the
          stored snapshot. Never rendered — a visible textbox carrying the
          approved text is a second thing the user has to trust says the same
          thing. */}
      {editableTextField(tool) ? (
        <input type="hidden" name="editText" value={edit[editableTextField(tool)!] ?? ""} />
      ) : null}
    </form>
  );
}

/** The one field this card edits, or `null` when the tool edits none. */
function editableTextField(tool: ToolSpec | null): string | null {
  if (!tool) return null;
  const fields = editableFields(tool);
  // The registry has exactly one editable field, and it carries the content. If
  // a second is ever added, this returns the first and the form would silently
  // drop the other — so the count is checked rather than assumed.
  return fields.length === 1 ? fields[0] : null;
}

function DeadlineBadge({
  overdue,
  soon,
  label,
}: {
  overdue: boolean;
  soon: boolean;
  label: string;
}) {
  return (
    <Badge variant={overdue ? "danger" : soon ? "warning" : "quiet"}>
      {label}
    </Badge>
  );
}

/**
 * The snapshot's fields, one per line, with editable ones as textareas.
 *
 * A field the tool does not declare is not rendered at all rather than dumped
 * as JSON. The snapshot is the tool's own input, and a tool that gained a field
 * the screen has never heard of should show less, not show a raw object next to
 * a label — an unlabelled JSON blob on an approval screen is precisely the
 * "showing a reference" failure the snapshot design exists to prevent.
 */
function Fields({
  tool,
  input,
  editable,
  edit,
  onEdit,
}: {
  tool: ToolSpec;
  input: Record<string, unknown>;
  editable: Set<string>;
  edit: Record<string, string>;
  onEdit: (next: Record<string, string>) => void;
}) {
  return (
    <div className="space-y-4">
      {tool.fields.map((field) => {
        const value = input[field.name];
        const shown =
          value === undefined || value === null ? "" : String(value);
        const isEditable = editable.has(field.name);
        const limit = field.maxChars;

        if (!isEditable) {
          return (
            <div key={field.name} className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                {field.name}
              </Label>
              <p className="whitespace-pre-wrap rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm">
                {shown || (
                  <span className="text-muted-foreground">(empty)</span>
                )}
              </p>
            </div>
          );
        }

        const draft = edit[field.name] ?? shown;
        const over = limit !== undefined && draft.length > limit;

        return (
          <div key={field.name} className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <Label htmlFor={`${field.name}-${tool.name}`} className="text-xs uppercase tracking-wider text-muted-foreground">
                {field.name}
              </Label>
              {limit !== undefined ? (
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    over ? "text-red-500" : "text-muted-foreground",
                  )}
                >
                  {draft.length} / {limit}
                </span>
              ) : null}
            </div>
            <Textarea
              id={`${field.name}-${tool.name}`}
              rows={6}
              value={draft}
              onChange={(event) =>
                onEdit({ ...edit, [field.name]: event.target.value })
              }
              className={over ? "border-red-500/60" : undefined}
            />
            {over ? (
              <p className="text-xs text-red-500">
                {draft.length - (limit ?? 0)} characters over the limit this tool
                allows. The server will refuse it.
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A snapshot whose tool this build does not have.
 *
 * The answer is not offered. An approval the screen cannot render is an
 * approval the user cannot meaningfully consent to, and the buttons for a tool
 * with no declared fields are buttons that would approve a payload nobody has
 * looked at.
 */
function UnknownTool({ name }: { name: string }) {
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] p-4 text-sm">
      <p className="font-medium">
        &quot;{name}&quot; is not a tool this build knows about.
      </p>
      <p className="mt-1 text-muted-foreground">
        It cannot be shown, so it cannot be approved from here. Rejecting it is
        still the right answer if you do not recognise it.
      </p>
    </div>
  );
}

/**
 * What the server said.
 *
 * Rendered from the action's return value, never from anything the component
 * concluded. `issues` is shown verbatim and in full — `applyEdit` collects every
 * reason a value was refused, and a screen that showed only the first would send
 * a user through the same round trip for each remaining one.
 */
function Result({ state }: { state: DecideApprovalState | null }) {
  if (!state) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "rounded-md border p-3 text-sm",
        state.ok
          ? "border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-600 dark:text-emerald-400"
          : "border-red-500/30 bg-red-500/[0.06] text-red-600 dark:text-red-400",
      )}
    >
      <p>{state.message}</p>
      {state.issues && state.issues.length > 0 ? (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {state.issues.map((issue, index) => (
            <li key={index}>{issue}</li>
          ))}
        </ul>
      ) : null}
      {state.changed && state.changed.length > 0 ? (
        <p className="mt-2 text-xs opacity-80">
          Published with your edit to {state.changed.join(", ")}.
        </p>
      ) : null}
    </div>
  );
}

/** A link out to the run this question belongs to. */
export function ApprovalRunLink({ runId }: { runId: string }) {
  return (
    <Button asChild variant="ghost" size="sm">
      <Link href={`/runs/${runId}`}>
        Open the run
        <ExternalLink className="size-4" />
      </Link>
    </Button>
  );
}
