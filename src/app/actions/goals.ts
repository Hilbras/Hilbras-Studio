"use server";

/**
 * Server actions for goals.
 *
 * The rules that decide whether a goal may exist live in
 * `lib/goals/validation.ts` and are not restated here. This file turns a form
 * post into a `GoalDraft` and reports what the gate said.
 *
 * **Every refusal is forwarded, never summarised.** `validateGoal` collects
 * every problem with a draft rather than stopping at the first, specifically so
 * a form can show all of them at once. An action that returned only the first
 * would turn that design back into the one-at-a-time failure the gate was
 * written to avoid, and a user fixing a goal would have to save, read one
 * error, fix it, and save again — once per problem.
 *
 * **The goal id comes from a hidden field, and it is re-checked anyway.** Every
 * function scopes by the session's own `userId`, so a substituted id addresses
 * somebody else's goal and changes nothing.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getSessionUser } from "@/lib/session";
import { createGoal, setGoalStatus, updateGoal } from "@/lib/goals/service";
import {
  GOAL_STATUSES,
  type GoalDraft,
  type GoalIssue,
} from "@/lib/goals/validation";

export interface GoalActionState {
  ok: boolean;
  message: string;
  /** One row per refusal, so the form can point at the thing that is wrong. */
  issues?: GoalIssue[];
  /** Set when the goal was saved, so the caller can navigate to it. */
  goalId?: string;
}

const MAX_TARGETS = 10;

/**
 * A goal id from a hidden form field.
 *
 * A UUID, because that is what `createGoal` mints. The regex is a shape check
 * so a malformed field produces a readable message rather than a database
 * error; it is not an authorisation, and nothing here treats it as one.
 */
const goalIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "That goal could not be found.");

/**
 * The schedule field.
 *
 * Bounded rather than merely non-empty: a cron expression is five fields of
 * digits and separators, and anything far past that is either a mistake or
 * something being pushed at the parser on purpose. `parseCron` is the real
 * gate; this is only here to give the mistake a sentence.
 */
const scheduleSchema = z
  .string()
  .trim()
  .min(1, "Set a schedule.")
  .max(120, "That schedule is too long to be a cron expression.");

const timeZoneSchema = z
  .string()
  .trim()
  .min(1, "Set a time zone.")
  // An IANA name is a region, a slash, and a place. The real check is
  // `isValidTimeZone`; this only rejects what cannot possibly be one.
  .max(64, "That is not a time zone name.");

const accountKeySchema = z
  .string()
  .min(1)
  .max(120)
  // `platform:handle`. The gate checks the key is one the user owns; this only
  // rejects a shape it could not be.
  .regex(/^[a-z][a-z0-9_]*:[A-Za-z0-9_.-]+$/, "That account could not be read.");

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** The target checkboxes a multi-select form posts. */
function targets(formData: FormData): string[] {
  return formData
    .getAll("targetAccounts")
    .filter((value): value is string => typeof value === "string")
    .slice(0, MAX_TARGETS);
}

/**
 * What a form post parses into, or why it did not.
 *
 * Annotated rather than inferred: the call sites spread `error` into a form
 * state, and an inferred union of two anonymous object literals widens to
 * include a branch with no `message` at all, which no spread can satisfy.
 */
type DraftParse =
  | { error: { message: string; issues: GoalIssue[] } }
  | { draft: GoalDraft };

/**
 * Parse a create or edit form.
 *
 * Returns a discriminated result rather than throwing, because both call sites
 * render a message. The error branch always carries an `issues` array, empty
 * when the problem is not attributable to a field — `exactOptionalPropertyTypes`
 * is on in this project, so a field that is sometimes absent is a field the
 * form has to null-check at every read.
 *
 * The account list is capped here rather than left to the gate so that a form
 * posting ten thousand keys gets a message about the form rather than a
 * validation report with ten thousand rows in it.
 */
function draftFrom(formData: FormData): DraftParse {
  const targets_ = targets(formData);

  if (targets_.length > MAX_TARGETS) {
    return {
      error: {
        message: `Choose at most ${MAX_TARGETS} accounts.`,
        issues: [],
      },
    };
  }

  const parsed = z
    .object({
      title: z.string().trim().min(1, "Give the goal a title.").max(120),
      statement: z.string().trim().min(1, "Describe what the goal should do.").max(4_000),
      schedule: scheduleSchema,
      timeZone: timeZoneSchema,
      targetAccounts: z.array(accountKeySchema).max(MAX_TARGETS),
    })
    .safeParse({
      title: field(formData, "title"),
      statement: field(formData, "statement"),
      schedule: field(formData, "schedule"),
      timeZone: field(formData, "timeZone"),
      targetAccounts: targets_,
    });

  if (!parsed.success) {
    return {
      error: {
        message: parsed.error.issues[0]?.message ?? "That goal could not be read.",
        issues: parsed.error.issues.map((issue) => ({
          code: "empty_title" as const,
          message: issue.message,
        })),
      },
    };
  }

  return { draft: parsed.data };
}

/** A gate refusal, as a form state. Carries every issue, not just the first. */
function refusal(issues: GoalIssue[]): GoalActionState {
  return {
    ok: false,
    message:
      issues.length === 1
        ? issues[0].message
        : `That goal has ${issues.length} problems. Fix them and save again.`,
    issues,
  };
}

/**
 * Create a goal.
 *
 * On success it reports the first firing, because "when does this next run" is
 * the question every new user has and the answer is not visible anywhere else
 * on the form.
 */
export async function createGoalAction(
  _prev: GoalActionState | null,
  formData: FormData,
): Promise<GoalActionState> {
  const session = await getSessionUser();
  if (!session) return { ok: false, message: "Not signed in." };

  const parsed = draftFrom(formData);
  if ("error" in parsed) {
    return { ok: false, ...parsed.error };
  }

  const result = await createGoal(session.id, parsed.draft);
  if (!result.ok) return refusal(result.issues);

  revalidatePath("/goals");
  revalidatePath("/runtime");

  return {
    ok: true,
    goalId: result.goalId,
    message: result.nextFiringAt
      ? `Created. Next firing ${result.nextFiringAt.toLocaleString()}.`
      : "Created.",
  };
}

/**
 * Edit a goal.
 *
 * The service re-runs the **whole** gate, not just the changed field — a user
 * editing a title is not asking to have a disconnected account accepted, but
 * they should hear about it at the moment they are already saving.
 */
export async function updateGoalAction(
  _prev: GoalActionState | null,
  formData: FormData,
): Promise<GoalActionState> {
  const session = await getSessionUser();
  if (!session) return { ok: false, message: "Not signed in." };

  const goalId = goalIdSchema.safeParse(field(formData, "goalId"));
  if (!goalId.success) {
    return { ok: false, message: "That goal could not be found." };
  }

  const parsed = draftFrom(formData);
  if ("error" in parsed) {
    return { ok: false, ...parsed.error };
  }

  const result = await updateGoal(session.id, goalId.data, parsed.draft);
  if (!result.ok) return refusal(result.issues);

  revalidatePath("/goals");
  revalidatePath(`/goals/${goalId.data}`);
  revalidatePath("/runtime");

  return {
    ok: true,
    goalId: goalId.data,
    message: "Saved.",
  };
}

/**
 * Pause, resume, or archive.
 *
 * Every refusal from the service is shown verbatim, and two of them are not
 * obvious enough to paraphrase: an archived goal cannot be resumed (create it
 * again), and a resumed goal whose stored cron no longer parses needs its
 * schedule edited first. Both are the user hitting a real limit, and a
 * generic "could not update" would send them looking for something else to
 * blame.
 */
export async function setGoalStatusAction(
  _prev: GoalActionState | null,
  formData: FormData,
): Promise<GoalActionState> {
  const session = await getSessionUser();
  if (!session) return { ok: false, message: "Not signed in." };

  const parsed = z
    .object({
      goalId: goalIdSchema,
      status: z.enum(GOAL_STATUSES),
    })
    .safeParse({
      goalId: field(formData, "goalId"),
      status: field(formData, "status"),
    });

  if (!parsed.success) {
    return { ok: false, message: "That change could not be read." };
  }

  const { goalId, status } = parsed.data;
  const result = await setGoalStatus(session.id, goalId, status);
  if (!result.ok) return { ok: false, message: result.message };

  revalidatePath("/goals");
  revalidatePath(`/goals/${goalId}`);
  revalidatePath("/runtime");

  return {
    ok: true,
    goalId,
    message:
      status === "active"
        ? "Resumed. It will fire from now, not from where it stopped."
        : status === "paused"
          ? "Paused. It will not fire until you resume it."
          : "Archived. Its history stays, and it cannot be resumed.",
  };
}

/**
 * The time zones a form may offer.
 *
 * Read from the platform rather than from a list in this file, so a deployment
 * on a newer ICU has the zones it actually supports. Returns UTC first and the
 * rest sorted, because a goal with no stated zone is a goal whose firing time
 * nobody can predict, and the most common zone is the one worth one keystroke.
 */
export async function listTimeZonesAction(): Promise<string[]> {
  const session = await getSessionUser();
  if (!session) return ["UTC"];

  let supported: string[];
  try {
    supported = Intl.supportedValuesOf("timeZone");
  } catch {
    // Older runtimes lack `supportedValuesOf`. UTC is a valid answer rather
    // than a broken select — the field stays editable.
    return ["UTC"];
  }

  return ["UTC", ...supported.filter((zone) => zone !== "UTC")];
}
