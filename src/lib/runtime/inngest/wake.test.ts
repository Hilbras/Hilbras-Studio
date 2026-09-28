import { describe, expect, it, vi } from "vitest";

import { APPROVAL_DECIDED } from "./client";
import { wakeRun } from "./wake";

/**
 * v0.9.0 (Phase 7): waking the queue is best-effort, and that is the design.
 *
 * The one behaviour worth holding is the *absence* of a failure. `decideApproval`
 * has already committed by the time `wakeRun` is called, so a send that throws
 * leaves the system in a state that is correct and merely slow — the sweeper
 * re-sends within five minutes. The alternative, propagating, reports a failure
 * that did not happen: the user presses Approve again and is told
 * `already_decided` about an approval they already answered, which is a worse
 * outcome than the five minutes it was trying to save.
 *
 * A test that cannot fail this way is worth nothing here, so the sender is
 * injected and made to throw.
 */
describe("waking the queue after a decision", () => {
  it("sends the event with the two identifiers and nothing else", async () => {
    const send = vi.fn().mockResolvedValue({ id: "evt-1" });

    await wakeRun(send, { runId: "run-1", approvalId: "approval-1" });

    expect(send).toHaveBeenCalledTimes(1);
    // Identifiers only. The event says a decision exists; it does not say which
    // way it went, and it must never carry the post text — a queue that could be
    // inspected would otherwise be a place an unapproved draft came to rest.
    expect(send).toHaveBeenCalledWith({
      name: APPROVAL_DECIDED,
      data: { runId: "run-1", approvalId: "approval-1" },
    });
  });

  it("does not report a failure when the queue is unreachable", async () => {
    const send = vi.fn().mockRejectedValue(new Error("queue unavailable"));

    // Resolves, rather than rejecting. This is the whole rule.
    await expect(
      wakeRun(send, { runId: "run-1", approvalId: "approval-1" }),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("swallows every failure shape, not just an Error", async () => {
    // A sender that rejects with something unrecognisable — a string, or a
    // thrown value from a non-Error source — must not become a 500 either.
    for (const thrown of ["offline", undefined, { code: 500 }, 0]) {
      const send = vi.fn().mockRejectedValue(thrown);
      await expect(
        wakeRun(send, { runId: "run-1", approvalId: "approval-1" }),
      ).resolves.toBeUndefined();
    }
  });

  it("still swallows when the sender throws synchronously", async () => {
    // `inngest.send` is async, but a stubbed or replaced client need not be, and
    // a `try` that only caught rejections would let a synchronous throw escape.
    const send = vi.fn(() => {
      throw new Error("no client configured");
    });

    await expect(
      wakeRun(send, { runId: "run-1", approvalId: "approval-1" }),
    ).resolves.toBeUndefined();
  });
});
