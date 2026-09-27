import { describe, expect, it } from "vitest";

import {
  APPROVAL_WINDOW_MS,
  applyEdit,
  approvalDeadline,
  approvalExpiredError,
  approvalRejectedError,
  approvableToolFor,
  approvableToolNames,
  isApprovableTool,
  isOverdue,
  policyDeniedError,
  validatePolicyTarget,
} from "./approvals";
import { makeRef } from "./references";
import { getTool, toolCatalogue } from "./tools";

const publish = () => getTool("publish_post")!;
const compose = () => getTool("compose_post")!;

describe("the approval window", () => {
  it("stamps a deadline a day out", () => {
    const now = new Date("2026-09-27T09:00:00Z");
    expect(approvalDeadline(now).toISOString()).toBe("2026-09-28T09:00:00.000Z");
    expect(APPROVAL_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("treats the exact deadline as closed", () => {
    // `>=`, and the same boundary the sweeper's query uses. An approval answered
    // at the instant its window closes is already late, so a caller can state
    // "answerable until T" without having to add "or just after" — and the reader
    // and the writer cannot disagree about which side a decision fell on.
    const deadline = new Date("2026-09-28T09:00:00Z");
    expect(isOverdue(deadline, new Date("2026-09-28T08:59:59.999Z"))).toBe(false);
    expect(isOverdue(deadline, deadline)).toBe(true);
    expect(isOverdue(deadline, new Date("2026-09-28T09:00:00.001Z"))).toBe(true);
  });
});

describe("which tools are approvable", () => {
  it("gates the tool that changes something and not the one that computes", () => {
    // The distinction is `sideEffect`, declared per tool. Inferring it from
    // `capability !== null` would start gating a read-only connector tool the
    // day one is added, putting a question in front of a step that publishes
    // nothing.
    expect(isApprovableTool(publish())).toBe(true);
    expect(isApprovableTool(compose())).toBe(false);
    expect(approvableToolFor("publish_post")).toBe(publish());
    expect(approvableToolFor("compose_post")).toBeNull();
    expect(approvableToolFor("nope")).toBeNull();
  });

  it("names every approvable tool from the registry, not a hardcoded list", () => {
    expect(approvableToolNames()).toEqual(
      toolCatalogue().filter((t) => t.sideEffect).map((t) => t.name),
    );
  });
});

describe("applyEdit", () => {
  const snapshot = { text: "one concrete reason weekly beats monthly" };

  it("replaces the text and says what changed", () => {
    const result = applyEdit(snapshot, { text: "three reasons" }, publish());
    expect(result).toEqual({
      ok: true,
      input: { text: "three reasons" },
      changed: ["text"],
    });
  });

  it("keeps the fields the person did not touch", () => {
    // The snapshot is the whole input, so a field the approval screen does not
    // show has to survive the merge intact. Dropping it would silently change
    // what gets published.
    const result = applyEdit(
      { text: "original", mediaUrl: "https://example.com/a.png" },
      { text: "edited" },
      publish(),
    );
    expect(result.ok && result.input).toEqual({
      text: "edited",
      mediaUrl: "https://example.com/a.png",
    });
  });

  it("refuses a field the tool does not let a person change", () => {
    // `mediaUrl` is not editable. Adding an image to somebody's post is a new
    // capability being granted, and an approval screen is the wrong place to
    // grant it.
    const result = applyEdit(snapshot, { mediaUrl: "https://evil.example/x.png" }, publish());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0]).toContain("not something you can change");
  });

  it("refuses a field the tool does not have at all", () => {
    const result = applyEdit(snapshot, { text: "ok", targetAccount: "instagram:x" }, publish());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0]).toContain('has no field called "targetAccount"');
  });

  it("refuses a reference dressed up as an edit", () => {
    // A `$ref` is valid *plan* input and `validateToolInput` rightly accepts one.
    // But a person editing text supplies a literal, and an object shaped like a
    // reference is either a client bug or an attempt to point the publish at some
    // other step's output — which is the one thing the approval screen must not
    // be able to do.
    const result = applyEdit(snapshot, { text: makeRef(0, "text") }, publish());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0]).toContain("must be plain text");
  });

  it("holds the edit to the platform's limit, not just the spec's", () => {
    // `text`'s declared `maxChars` is 20,000 — a sanity ceiling, not X's limit.
    // Without the injected platform limit an approver could approve 2,400
    // characters for X and only find out when the platform rejected it, after
    // they had said yes.
    const long = "a".repeat(400);
    const result = applyEdit(snapshot, { text: long }, publish(), {
      fieldLimits: { text: 280 },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0]).toContain("this platform allows 280");
  });

  it("does not apply a text limit to a field that is not text", () => {
    const result = applyEdit(
      { text: "hello" },
      {},
      publish(),
      { fieldLimits: { mediaUrl: 10 } },
    );
    expect(result.ok).toBe(true);
  });

  it("runs the edit through the plan's own validator", () => {
    // The load-bearing rule. An empty edit is valid, so the only thing that can
    // reject it is the shared validator refusing an input no plan would be
    // allowed to contain.
    const blank = applyEdit(snapshot, { text: "   " }, publish());
    expect(blank.ok).toBe(false);
    expect(!blank.ok && blank.issues[0]).toContain("must be non-empty text");
  });

  it("reports every rejected key at once, and does not then validate the merge", () => {
    // Two problems, both reported, rather than one per submit. But once a key
    // has been rejected the merge is not the document the person wrote, so
    // running the shared validator over it would describe an input they never
    // chose — "text must be non-empty" for a `text` they did not send. They fix
    // the keys first and the next submit is the one that gets fully checked.
    const result = applyEdit(
      snapshot,
      { mediaUrl: "https://example.com/x.png", nope: "1" },
      publish(),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues).toHaveLength(2);
    expect(!result.ok && result.issues[0]).toContain("not something you can change");
    expect(!result.ok && result.issues[1]).toContain('has no field called "nope"');
  });

  it("still validates the merge when every key was accepted", () => {
    // The complementary case: nothing was rejected, so the only thing left to say
    // something is the plan's own validator.
    const result = applyEdit(snapshot, { text: "" }, publish());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0]).toContain("must be non-empty text");
  });

  it("reports no change when the value is identical", () => {
    // The event detail distinguishes "approved as written" from "approved with
    // an edit", which is worth knowing and not worth recording when nothing
    // actually changed.
    const result = applyEdit(snapshot, { text: snapshot.text }, publish());
    expect(result.ok && result.changed).toEqual([]);
  });

  it("leaves nothing editable on a tool with no side effect", () => {
    // `compose_post` cannot be edited because there is nothing a person could
    // meaningfully approve: the text it writes does not exist yet.
    const result = applyEdit({ brief: "an angle" }, { brief: "another" }, compose());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0]).toContain("not something you can change");
  });
});

describe("validatePolicyTarget", () => {
  const owned = { accountKeys: ["x:hilbras", "instagram:hilbras"] };

  it("accepts an account the user owns", () => {
    expect(validatePolicyTarget("account", "x:hilbras", owned)).toEqual({ ok: true });
  });

  it("refuses an account the user does not own", () => {
    // Inert, and worse than inert: a typo would leave the user believing they had
    // disabled something they had not.
    expect(validatePolicyTarget("account", "x:someone-else", owned)).toEqual({
      ok: false,
      reason: '"x:someone-else" is not one of your accounts.',
    });
  });

  it("accepts a tool that has a side effect", () => {
    expect(validatePolicyTarget("tool", "publish_post", owned)).toEqual({ ok: true });
  });

  it("refuses a name that is not a tool", () => {
    expect(validatePolicyTarget("tool", "delete_everything", owned)).toEqual({
      ok: false,
      reason: '"delete_everything" is not a tool.',
    });
  });

  it("refuses a tool that changes nothing, rather than accepting a dead setting", () => {
    // "Require approval before compose_post" cannot be honoured. The text it
    // writes does not exist yet, so the most the Runtime could do is approve a
    // brief — and the user would believe their account was gated.
    const result = validatePolicyTarget("tool", "compose_post", owned);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("changes nothing outside Studio");
    expect(!result.ok && result.reason).toContain("publish_post");
  });
});

describe("the errors a decision produces", () => {
  it("never marks any of them retryable", () => {
    // A policy that forbids an action will forbid it next time too, a person said
    // no, and a deadline that has passed will not un-pass. In all three cases
    // another attempt buys nothing but a run spent to learn the same thing.
    for (const error of [
      policyDeniedError("publish_post", "x:hilbras"),
      approvalRejectedError("x:hilbras"),
      approvalExpiredError("x:hilbras"),
    ]) {
      expect(error.retryable).toBe(false);
    }
  });

  it("says which account and which tool, so a user can act on it", () => {
    expect(policyDeniedError("publish_post", "x:hilbras").message).toContain(
      "x:hilbras",
    );
    expect(policyDeniedError("publish_post", "x:hilbras").message).toContain(
      "publish_post",
    );
    expect(approvalRejectedError("x:hilbras").code).toBe("approval_rejected");
    expect(approvalExpiredError("x:hilbras").code).toBe("approval_expired");
  });

  it("tells a person why a timeout did not publish", () => {
    // The absence of an answer is the reason. Saying so is the difference between
    // a user understanding the run and a user thinking the system lost it.
    expect(approvalExpiredError("x:hilbras").message).toContain("not published");
  });
});
