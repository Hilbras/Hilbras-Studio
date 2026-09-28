import { APPROVAL_DECIDED } from "./client";

/**
 * Tell the queue a decision was recorded.
 *
 * **Best-effort on purpose, and the swallowing is the design.** By the time
 * this runs the decision is durably written: `decideApproval` committed it
 * before returning. The event is not the record of the decision, it is only the
 * instruction to go and act on it — which is why the sweeper exists to re-send
 * anything that never arrived.
 *
 * So a failure here must not be reported to the user. Telling someone their
 * approval failed when it was in fact recorded and will be picked up within
 * five minutes would be worse than the delay it hides: they would press Approve
 * again, and get `already_decided` for an approval they had already answered.
 *
 * Without this call the delay is not an edge case — it is every approval, since
 * nothing else sends the event. The sweeper runs every five minutes, which is a
 * long time to stare at a post you just approved.
 *
 * ## Why this is in `lib/` and not in the action
 *
 * It is a rule about failure, not a step in a request, and ADR-004 says rules
 * live where they can be tested without a form. As a private function in a
 * `"use server"` module it could only be reached through an action, which would
 * mean standing up a session, a form post, and a database to assert that a
 * thrown error is *not* propagated — a test so expensive it would not get
 * written. The `send` parameter is what makes it testable at all: the rule is
 * "a failed send is not a failed approval", and the cheapest way to check that
 * is to hand it a sender that throws.
 */
export async function wakeRun(
  send: (event: { name: typeof APPROVAL_DECIDED; data: { runId: string; approvalId: string } }) => Promise<unknown>,
  input: { runId: string; approvalId: string },
): Promise<void> {
  try {
    await send({ name: APPROVAL_DECIDED, data: input });
  } catch {
    // Deliberately swallowed. See above: the decision is already stored and the
    // sweeper re-sends. Reporting this would be reporting a false failure.
  }
}
