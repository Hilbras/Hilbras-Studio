/**
 * The Inngest client (ADR-001).
 *
 * Durable execution runs on a managed queue rather than a Vercel cron or a
 * self-hosted worker. Phase 6 is what decided it: an approval that waits hours
 * or days for a human is a first-class primitive here, not a state machine we
 * would otherwise hand-roll on top of a queue.
 *
 * The event key stays small on purpose. Only identifiers cross this boundary —
 * a goal id and a schedule slot. No user content, no credentials, no tokens.
 * Everything else is read from Postgres inside the function, so the queue is
 * never a place where a secret or a draft could come to rest.
 */

import { Inngest } from "inngest";

/**
 * The only events the Runtime accepts.
 *
 * Schemas pin event payloads, so a change to what the scheduler sends is a
 * type error rather than a runtime surprise.
 */
export const schemas = {
  "hilbras/studio/goal-scheduled": {
    goalId: "string",
    userId: "string",
    /** The firing slot, e.g. "2026-09-27T10:00Z". */
    scheduleSlot: "string",
    /** 1 for the first attempt; incremented by the retry path. */
    attempt: "number",
  },
};

export const inngest = new Inngest({
  id: "hilbras-studio",
  schemas,
});

export const GOAL_SCHEDULED = "hilbras/studio/goal-scheduled" as const;
