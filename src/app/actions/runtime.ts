"use server";

/**
 * Server actions for the Runtime screens.
 *
 * Three rules, and every function here obeys all three.
 *
 * **1. Resolve the user from the session, never from the arguments.** Each
 * action calls `getSessionUser` itself. Nothing a caller passes identifies who
 * is asking, so an action cannot be aimed at another tenant by editing a form
 * post. Where a call *also* takes a user id — it does not — the two would have
 * to agree, and that is a check nobody remembers to write.
 *
 * **2. Say what happened, do not assert what happened.** Every action returns
 * the result the server computed. A "Done!" message is a claim about state made
 * by the same code that changed it, and if the two ever disagree the message is
 * a lie the user acts on. A refusal is returned as a refusal, including the
 * cases that are the action's own fault, like an edit the plan gate rejects.
 *
 * **3. Thin.** Validate the shape, call one service function, map the result
 * onto something renderable. The rules live in `lib/` where they can be tested
 * without a form, and where a second caller would be held to the same ones
 * (ADR-004).
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getSessionUser } from "@/lib/session";
import { inngest } from "@/lib/runtime/inngest/client";
import { wakeRun } from "@/lib/runtime/inngest/wake";
import {
  clearPolicy,
  decideApproval,
  describePolicyTargets,
  listPendingApprovals,
  listPolicyRows,
  setPolicy,
  type DecideResult,
} from "@/lib/runtime/approval-store";
import { POLICY_SCOPES } from "@/lib/runtime/approvals";
import { getRunDetail, listRuns } from "@/lib/runtime/queries";

/** What a form shows back. Never a state the server did not report. */
export interface ActionState {
  ok: boolean;
  message: string;
  /** Per-field problems, when the problem is a set of fields. */
  issues?: string[];
}

const ok = (message: string): ActionState => ({ ok: true, message });

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

const approvalIdSchema = z
  .string()
  .regex(/^[0-9a-f-]{36}$/i, "That approval could not be found.");

const decisionSchema = z.enum(["approved", "rejected"]);

/**
 * The shape a decision form submits.
 *
 * `edit` is a *sparse* patch of field names, not a whole input object. The
 * distinction is the reason this is a `record` of strings rather than a parsed
 * object: an absent key means "the person did not touch this", and an absent key
 * is not the same as a key set to the empty string. Merging the patch over the
 * stored snapshot — which `applyEdit` does, server-side, from the snapshot this
 * screen never sent — is what keeps a stale browser tab from silently
 * replacing a value the person never saw.
 *
 * The text is capped at 20 000 characters so a form post cannot be used to push
 * an unbounded body at the server. It is far above any platform's own limit,
 * which `applyEdit` then enforces properly against the real one.
 */
const decideSchema = z.object({
  approvalId: approvalIdSchema,
  decision: decisionSchema,
  editText: z
    .string()
    .max(20_000, "That edit is too long to submit.")
    .optional(),
});

export interface DecideApprovalState extends ActionState {
  /** The input the step will run with, so the UI can show what was decided. */
  changed?: string[];
}

/**
 * Answer a question the Runtime is waiting on.
 *
 * `decideApproval` does the deciding — it re-reads the approval, checks the
 * owner, refuses a second answer, closes an expired window, and validates any
 * edit through the plan's own validator. This function's whole job is to get a
 * well-formed call into it and to wake the queue afterwards.
 */
export async function decideApprovalAction(
  _prev: DecideApprovalState | null,
  formData: FormData,
): Promise<DecideApprovalState> {
  const session = await getSessionUser();
  if (!session) return { ok: false, message: "Not signed in." };

  const parsed = decideSchema.safeParse({
    approvalId: formData.get("approvalId"),
    decision: formData.get("decision"),
    // `undefined` rather than "" so an untouched textarea is not an edit that
    // blanks the post.
    editText:
      typeof formData.get("editText") === "string" && formData.get("editText") !== ""
        ? formData.get("editText")
        : undefined,
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "That answer could not be read.",
    };
  }

  const { approvalId, decision, editText } = parsed.data;
  const edit = editText === undefined ? undefined : { text: editText };

  const result = await decideApproval({
    approvalId,
    userId: session.id,
    decision,
    ...(edit ? { edit } : {}),
  });

  if (!result.ok) return refusal(result);

  await wakeRun(
    (event) => inngest.send(event),
    { runId: result.approval.runId, approvalId },
  );

  revalidatePath("/approvals");
  revalidatePath("/runtime");
  revalidatePath(`/runs/${result.approval.runId}`);

  return {
    ok: true,
    message:
      decision === "approved"
        ? "Approved. The run is resuming."
        : "Rejected. That step will not run; the rest of the run continues.",
    ...(result.changed.length > 0 ? { changed: result.changed } : {}),
  };
}

/**
 * A store's `DecideResult` failure, rendered.
 *
 * Every code gets its own sentence rather than one "Something went wrong",
 * because the codes are not variations on a theme — `already_decided` and
 * `approval_expired` mean the user is looking at a stale page, `forbidden`
 * means they are looking at the wrong page, and `invalid_edit` means what they
 * typed is the problem. Collapsing them produces a message that is wrong in
 * every one of those cases.
 */
function refusal(result: Extract<DecideResult, { ok: false }>): ActionState {
  const base: ActionState = { ok: false, message: result.message };
  return result.issues ? { ...base, issues: result.issues } : base;
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

const policyKeySchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_:.-]+$/, "That target could not be read.");

const policySchema = z.object({
  scope: z.enum(POLICY_SCOPES),
  scopeKey: policyKeySchema,
  decision: z.enum(["auto", "approval", "disabled"]),
});

/**
 * Set what a user has decided about one target.
 *
 * A refusal here is worth showing verbatim. `setPolicy` refuses a target the
 * user does not own and a tool with no side effect, and both refusals mean
 * something specific went wrong with the form — a settings screen that quietly
 * drops them leaves the user believing a gate is in place that is not.
 */
export async function setPolicyAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await getSessionUser();
  if (!session) return { ok: false, message: "Not signed in." };

  const parsed = policySchema.safeParse({
    scope: formData.get("scope"),
    scopeKey: formData.get("scopeKey"),
    decision: formData.get("decision"),
  });
  if (!parsed.success) {
    return { ok: false, message: "That policy could not be read." };
  }

  const { scope, scopeKey, decision } = parsed.data;
  const result = await setPolicy(session.id, scope, scopeKey, decision);

  if (!result.ok) return { ok: false, message: result.reason };

  revalidatePath("/settings");
  return ok(`Saved. ${scopeKey} is now ${decision}.`);
}

/**
 * Remove one policy, returning to `auto`.
 *
 * Always reported as a success, because a policy that was already gone is the
 * state the user asked for. `clearPolicy` returns whether a row went away, and
 * that is a fact about the database rather than about the request.
 */
export async function clearPolicyAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await getSessionUser();
  if (!session) return { ok: false, message: "Not signed in." };

  const parsed = policySchema
    .pick({ scope: true, scopeKey: true })
    .safeParse({ scope: formData.get("scope"), scopeKey: formData.get("scopeKey") });
  if (!parsed.success) {
    return { ok: false, message: "That policy could not be read." };
  }

  const { scope, scopeKey } = parsed.data;
  await clearPolicy(session.id, scope, scopeKey);

  revalidatePath("/settings");
  return ok(`${scopeKey} is back to automatic.`);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The approval inbox, for a client component that has to refresh it in place.
 *
 * A plain read exposed as an action rather than fetched over HTTP: it is the same
 * session, the same server, and no route would otherwise exist for it. The
 * `userId` is resolved here for the same reason every other function resolves
 * it — a caller cannot ask for another tenant's inbox by passing an id.
 */
export async function listApprovalsAction() {
  const session = await getSessionUser();
  if (!session) return { ok: false as const, message: "Not signed in.", approvals: [] };

  return {
    ok: true as const,
    approvals: await listPendingApprovals(session.id),
  };
}

/** The runs a user has, for the history list. Capped server-side. */
export async function listRunsAction(limit?: number) {
  const session = await getSessionUser();
  if (!session) return [];
  return listRuns(session.id, { limit });
}

/** One run and its log, or `null` if it is not the caller's. */
export async function getRunDetailAction(runId: string) {
  const session = await getSessionUser();
  if (!session) return null;
  return getRunDetail(session.id, runId);
}

/** What a policy screen may name, and the policies already set. */
export async function loadPoliciesAction() {
  const session = await getSessionUser();
  if (!session) return null;
  const [targets, rows] = await Promise.all([
    describePolicyTargets(session.id),
    listPolicyRows(session.id),
  ]);
  return { targets, rows };
}
