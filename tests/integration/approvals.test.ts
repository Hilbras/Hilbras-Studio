import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PublishPostResult } from "../../src/lib/connectors/types";

import * as schema from "../../src/db/schema";

const {
  accounts,
  connections,
  executionPolicies,
  runEvents,
  runStepApprovals,
  runSteps,
  runs,
  users,
} = schema;

/**
 * v0.8.0 (Phase 6): a person decides whether a side effect may happen.
 *
 * The unit tests cover the window arithmetic, the edit validator, and the gate
 * contract with a fake database. What they cannot cover is the half that decides
 * whether a *post* happens unattended, and that is where the properties worth
 * holding live:
 *
 *  1. **The gate is reached with the text, not the reference.** A person asked
 *     about `{"$ref": …}` has not been asked anything, so the approval row has
 *     to hold the resolved input. Every other guarantee about approvals rests on
 *     the person having read the real content.
 *
 *  2. **What was approved is what publishes.** An edit is persisted, and the
 *     value the executor is handed comes from the approval row rather than from
 *     the plan. Anything else makes the approval a formality.
 *
 *  3. **An edit is checked by the plan's own validator.** A human at the approval
 *     screen is a later stage than the plan gate, so a weaker check there is a way
 *     around it.
 *
 *  4. **A decision is only the owner's.** One line of authorization, and the
 *     one that matters most, since the ids are the only thing between one user's
 *     approval and another's post.
 *
 *  5. **A deadline is enforced by a write, not by a reader.** A user can always
 *     answer afterwards, so a window only exists if something closes it.
 *
 *  6. **A suspension cannot be lost.** The queue is not transactional with
 *     Postgres, so a crash between "the person said yes" and "tell the queue"
 *     would otherwise strand the run forever.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let dbModule: typeof import("../../src/db");
let goalService: typeof import("../../src/lib/goals/service");
let runtimeService: typeof import("../../src/lib/runtime/service");
let runtimeQueries: typeof import("../../src/lib/runtime/queries");
let approvalStore: typeof import("../../src/lib/runtime/approval-store");
let executor: typeof import("../../src/lib/runtime/executor");
let originalDatabaseUrl: string | undefined;

const importForContainer = async <T>(path: string): Promise<T> =>
  import(resolve(process.cwd(), path));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  testDb = drizzle(pool, { schema });
  await migrate(testDb, { migrationsFolder: resolve(process.cwd(), "drizzle") });

  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = container.getConnectionUri();

  dbModule = await importForContainer<typeof import("../../src/db")>("src/db");
  goalService = await importForContainer<typeof import("../../src/lib/goals/service")>(
    "src/lib/goals/service",
  );
  runtimeService = await importForContainer<
    typeof import("../../src/lib/runtime/service")
  >("src/lib/runtime/service");
  runtimeQueries = await importForContainer<
    typeof import("../../src/lib/runtime/queries")
  >("src/lib/runtime/queries");
  approvalStore = await importForContainer<
    typeof import("../../src/lib/runtime/approval-store")
  >("src/lib/runtime/approval-store");
  executor = await importForContainer<typeof import("../../src/lib/runtime/executor")>(
    "src/lib/runtime/executor",
  );
});

afterAll(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await pool?.end();
  await dbModule?.closeDb();
  await container?.stop();
});

/** A user with two publishing accounts: one at 280 characters, one at 2200. */
async function seedUser(prefix: string): Promise<string> {
  const userId = randomUUID();
  await testDb.insert(users).values({
    id: userId,
    name: prefix,
    email: `${prefix}@example.invalid`,
    username: prefix,
    passwordHash: "not-a-real-hash",
  });

  const connectionId = randomUUID();
  await testDb.insert(connections).values({
    id: connectionId,
    userId,
    platform: "x",
    accessTokenEnc: "not-a-real-token",
  });

  await testDb.insert(accounts).values([
    {
      id: randomUUID(),
      userId,
      connectionId,
      platform: "x",
      accountKey: "x:hilbras",
      platformAccountId: "1",
      enabled: true,
      capabilities: null,
    },
    {
      id: randomUUID(),
      userId,
      connectionId,
      platform: "instagram",
      accountKey: "instagram:hilbras",
      platformAccountId: "2",
      enabled: true,
      capabilities: null,
    },
  ]);

  return userId;
}

async function createGoal(userId: string, over: Record<string, unknown> = {}) {
  const result = await goalService.createGoal(userId, {
    title: "Daily AI commentary",
    statement: "Post every morning about something in AI worth reading.",
    schedule: "0 9 * * *",
    timeZone: "Europe/Berlin",
    targetAccounts: ["x:hilbras"],
    from: new Date("2026-09-27T12:00:00Z"),
    ...over,
  } as never);
  if (!result.ok) {
    throw new Error(`fixture goal refused: ${result.issues.map((i) => i.code).join(", ")}`);
  }
  return result.goalId;
}

/**
 * A run with one `publish_post` step, already planned.
 *
 * The plan is written straight through the executor's own shape rather than
 * through the planner: these tests are about what happens once a step is about to
 * act, and a scripted model reply would only add a way for them to fail for a
 * reason that is not the subject.
 */
async function seedPublishRun(
  userId: string,
  options: { input?: Record<string, unknown>; account?: string } = {},
): Promise<{ runId: string; stepId: string }> {
  const goalId = await createGoal(userId, {
    targetAccounts: [options.account ?? "x:hilbras"],
  });
  const run = await runtimeService.createRun({
    goalId,
    scheduleSlot: "2026-09-28T07:00Z",
  });
  if (!run.created) throw new Error("fixture run was not created");

  const stepId = randomUUID();
  await testDb.insert(runSteps).values({
    id: stepId,
    runId: run.runId,
    stepIndex: 0,
    label: "Publish",
    capability: "publish_post",
    targetAccount: options.account ?? "x:hilbras",
    state: "pending",
    input: JSON.stringify(options.input ?? { text: "one reason weekly beats monthly" }),
    idempotencyKey: `${run.runId}:0:${options.account ?? "x:hilbras"}`,
  });

  return { runId: run.runId, stepId };
}

/** A connector that records what it was given, so a publish can be asserted. */
function recordingConnector() {
  const calls: { text: string }[] = [];
  return {
    calls,
    connector: {
      platform: "x" as const,
      capabilities: ["publish_post" as const],
      publishPost: async (
        _context: unknown,
        input: { text?: string },
      ): Promise<PublishPostResult> => {
        calls.push({ text: input.text ?? "" });
        return {
          ok: true as const,
          platformPostId: "p-1",
          permalink: "https://x.com/hilbras/p/1",
        };
      },
    },
  };
}

const request = (userId: string, runId: string, stepId: string, over: Record<string, unknown> = {}) => ({
  runId,
  stepId,
  userId,
  tool: "publish_post",
  targetAccount: "x:hilbras",
  input: { text: "one reason weekly beats monthly" },
  ...over,
});

const approvalsOf = (runId: string) =>
  testDb.select().from(runStepApprovals).where(eq(runStepApprovals.runId, runId));

const stepsOf = (runId: string) =>
  testDb.select().from(runSteps).where(eq(runSteps.runId, runId));

const eventsOf = (runId: string) =>
  testDb.select().from(runEvents).where(eq(runEvents.runId, runId));

// ---------------------------------------------------------------------------

describe("execution policies", () => {
  it("stores a policy and resolves it into the shape the gate already reads", async () => {
    const userId = await seedUser("policy_store");
    expect(await approvalStore.setPolicy(userId, "tool", "publish_post", "approval")).toEqual({
      ok: true,
    });

    // The precedence rule was written and tested in v0.3.0; the table's only job
    // is to produce the two maps it reads, so there is one implementation of the
    // precedence rather than two.
    expect(await approvalStore.loadPolicy(userId)).toEqual({
      defaultDecision: "auto",
      byAccount: {},
      byCapability: { publish_post: "approval" },
    });
  });

  it("replaces a policy rather than accumulating rows", async () => {
    const userId = await seedUser("policy_replace");
    await approvalStore.setPolicy(userId, "tool", "publish_post", "approval");
    await approvalStore.setPolicy(userId, "tool", "publish_post", "disabled");

    const rows = await approvalStore.listPolicyRows(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("disabled");
  });

  it("keeps one user's policies out of another's", async () => {
    // The read is by user id, so a second user with no policies at all resolves
    // to the default. A missing `where` clause here would silently apply one
    // user's settings to everybody.
    const mine = await seedUser("policy_mine");
    const theirs = await seedUser("policy_theirs");
    await approvalStore.setPolicy(mine, "account", "x:hilbras", "disabled");

    expect((await approvalStore.loadPolicy(theirs)).byAccount).toEqual({});
    expect((await approvalStore.loadPolicy(mine)).byAccount).toEqual({
      "x:hilbras": "disabled",
    });
  });

  it("refuses a policy on an account the user does not own", async () => {
    const userId = await seedUser("policy_owner");
    const result = await approvalStore.setPolicy(userId, "account", "x:someone-else", "disabled");
    expect(result).toEqual({
      ok: false,
      reason: '"x:someone-else" is not one of your accounts.',
    });
    expect(await approvalStore.listPolicyRows(userId)).toHaveLength(0);
  });

  it("refuses a policy on a tool that changes nothing", async () => {
    // "Require approval before compose_post" cannot be honoured — the text it
    // writes does not exist yet — and accepting it would leave the user
    // believing their account was gated.
    const userId = await seedUser("policy_tool");
    const result = await approvalStore.setPolicy(userId, "tool", "compose_post", "approval");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("changes nothing outside Studio");
  });

  it("clears a policy, returning the user to the default", async () => {
    const userId = await seedUser("policy_clear");
    await approvalStore.setPolicy(userId, "account", "x:hilbras", "approval");
    expect(await approvalStore.clearPolicy(userId, "account", "x:hilbras")).toBe(true);
    expect(await approvalStore.loadPolicy(userId)).toEqual({
      defaultDecision: "auto",
      byAccount: {},
      byCapability: {},
    });
  });

  it("clears a policy for an account the user no longer holds", async () => {
    // A stuck setting is worse than a stale one. Deleting an account must not
    // leave behind a policy nobody can remove.
    const userId = await seedUser("policy_stale");
    await testDb.insert(executionPolicies).values({
      id: randomUUID(),
      userId,
      scope: "account",
      scopeKey: "x:disconnected",
      decision: "approval",
    });

    expect(await approvalStore.clearPolicy(userId, "account", "x:disconnected")).toBe(true);
  });

  it("treats an unrecognised stored decision as no rule", async () => {
    // A value this build does not know must not be interpreted as something it
    // nearly means. "approval" is the one that would matter, and a settings
    // screen from a later build writing it here would otherwise be read by an
    // earlier build as permission to publish unattended.
    const userId = await seedUser("policy_unknown");
    await testDb.insert(executionPolicies).values({
      id: randomUUID(),
      userId,
      scope: "tool",
      scopeKey: "publish_post",
      decision: "ask-me-maybe",
    });

    expect(await approvalStore.loadPolicy(userId)).toEqual({
      defaultDecision: "auto",
      byAccount: {},
      byCapability: {},
    });
  });
});

// ---------------------------------------------------------------------------

describe("the permission gate", () => {
  it("allows a side-effecting tool when no policy says otherwise", async () => {
    // The absent row is `auto`. A user with no policies publishes unattended,
    // which is what every existing user expects and what a new deployment should
    // not have to configure before it works.
    const userId = await seedUser("gate_auto");
    const gate = approvalStore.createApprovalGate(userId);
    const { stepId } = await seedPublishRun(userId);

    expect(await gate({ runId: "r", stepId, tool: "publish_post", targetAccount: "x:hilbras", input: {} }))
      .toEqual({ kind: "allow" });
  });

  it("never asks about a tool that changes nothing", async () => {
    // `compose_post` writes text that exists only inside the run. A question
    // about it would have no consequence behind it, and a policy demanding one
    // is refused at write time so the user is not misled.
    const userId = await seedUser("gate_compose");
    const gate = approvalStore.createApprovalGate(userId);

    expect(await gate({ runId: "r", stepId: "s", tool: "compose_post", input: {} })).toEqual({
      kind: "allow",
    });
  });

  it("asks, and records the question with the resolved text", async () => {
    // The load-bearing property of the whole phase: the approval holds what the
    // person will read. A snapshot of the `$ref` would be an approval of a JSON
    // object, and the edit that follows would have nothing to edit.
    const userId = await seedUser("gate_ask");
    await approvalStore.setPolicy(userId, "tool", "publish_post", "approval");
    const { runId, stepId } = await seedPublishRun(userId, {
      input: { text: "the words a person will read" },
    });

    const gate = approvalStore.createApprovalGate(userId);
    const answer = await gate({
      runId,
      stepId,
      tool: "publish_post",
      targetAccount: "x:hilbras",
      input: { text: "the words a person will read" },
    });

    expect(answer.kind).toBe("needs_approval");
    const [row] = await approvalsOf(runId);
    expect(row.state).toBe("pending");
    expect(JSON.parse(row.input)).toEqual({ text: "the words a person will read" });
    expect(row.tool).toBe("publish_post");
    expect(row.targetAccount).toBe("x:hilbras");
    expect(row.userId).toBe(userId);
  });

  it("asks the same question once, with the deadline it was created with", async () => {
    // `requestApproval` runs inside a queue closure that can replay. Two rows
    // would mean two people could approve two versions of one post, and a replay
    // that extended the window would be a question the user was not really
    // counting down.
    const userId = await seedUser("gate_idempotent");
    await approvalStore.setPolicy(userId, "tool", "publish_post", "approval");
    const { runId, stepId } = await seedPublishRun(userId);

    const first = await approvalStore.requestApproval(
      request(userId, runId, stepId, { now: new Date("2026-09-28T09:00:00Z") }),
    );
    const second = await approvalStore.requestApproval(
      request(userId, runId, stepId, { now: new Date("2026-09-28T23:00:00Z") }),
    );

    expect(second.id).toBe(first.id);
    expect(second.expiresAt.toISOString()).toBe(first.expiresAt.toISOString());
    expect(await approvalsOf(runId)).toHaveLength(1);
  });

  it("stamps a timezone-aware deadline", async () => {
    // `expires_at` is compared against `now()` in a query, so a naive timestamp
    // would make the deadline depend on the database session's TimeZone — the
    // same trap `goals.next_firing_at` hit in migration 0012.
    const userId = await seedUser("gate_tz");
    const { runId, stepId } = await seedPublishRun(userId);
    await approvalStore.requestApproval(
      request(userId, runId, stepId, { now: new Date("2026-09-28T09:00:00Z") }),
    );

    const rows = await pool.query(
      "SELECT pg_typeof(expires_at)::text AS kind FROM run_step_approvals WHERE step_id = $1",
      [stepId],
    );
    expect(rows.rows[0].kind).toBe("timestamp with time zone");
  });

  it("denies a forbidden action, naming the account", async () => {
    const userId = await seedUser("gate_denied");
    await approvalStore.setPolicy(userId, "account", "x:hilbras", "disabled");
    const { stepId } = await seedPublishRun(userId);

    const answer = await approvalStore.createApprovalGate(userId)({
      runId: "r",
      stepId,
      tool: "publish_post",
      targetAccount: "x:hilbras",
      input: {},
    });

    expect(answer.kind).toBe("deny");
    expect(answer.kind === "deny" && answer.error.code).toBe("policy_denied");
    expect(answer.kind === "deny" && answer.error.message).toContain("x:hilbras");
  });

  it("lets a per-account rule beat a per-tool one", async () => {
    // Precedence from v0.3.0, and the reason it is that way: a user who turns
    // publishing off for one noisy account means that account, not the tool
    // everywhere.
    const userId = await seedUser("gate_precedence");
    await approvalStore.setPolicy(userId, "tool", "publish_post", "approval");
    await approvalStore.setPolicy(userId, "account", "x:hilbras", "disabled");
    const { stepId } = await seedPublishRun(userId);

    const answer = await approvalStore.createApprovalGate(userId)({
      runId: "r",
      stepId,
      tool: "publish_post",
      targetAccount: "x:hilbras",
      input: {},
    });
    expect(answer.kind).toBe("deny");
  });

  it("refuses to publish after a policy is switched off mid-approval", async () => {
    // The case that makes the check order load-bearing. A user who leaves a post
    // waiting, then disables publishing, means it — and approving afterwards must
    // not publish something the policy now forbids. An approval is consent to a
    // permitted action, not a licence to perform a forbidden one.
    const userId = await seedUser("gate_disabled_after");
    await approvalStore.setPolicy(userId, "tool", "publish_post", "approval");
    const { runId, stepId } = await seedPublishRun(userId);

    const gate = approvalStore.createApprovalGate(userId);
    const asked = await gate({
      runId,
      stepId,
      tool: "publish_post",
      targetAccount: "x:hilbras",
      input: { text: "hello" },
    });
    expect(asked.kind).toBe("needs_approval");
    const approvalId = asked.kind === "needs_approval" ? asked.approvalId : "";

    const decided = await approvalStore.decideApproval({
      approvalId,
      userId,
      decision: "approved",
    });
    expect(decided.ok).toBe(true);

    await approvalStore.setPolicy(userId, "tool", "publish_post", "disabled");

    const after = await approvalStore.createApprovalGate(userId)({
      runId,
      stepId,
      tool: "publish_post",
      targetAccount: "x:hilbras",
      input: { text: "hello" },
    });
    expect(after.kind).toBe("deny");
  });

  it("allows a step whose approval is already recorded", async () => {
    // The path every resumed run takes. If this returned `needs_approval` the
    // run would ask the same question forever.
    const userId = await seedUser("gate_recorded");
    await approvalStore.setPolicy(userId, "tool", "publish_post", "approval");
    const { runId, stepId } = await seedPublishRun(userId);
    const asked = await approvalStore.requestApproval(request(userId, runId, stepId));
    await approvalStore.decideApproval({ approvalId: asked.id, userId, decision: "approved" });

    const after = await approvalStore.createApprovalGate(userId)({
      runId,
      stepId,
      tool: "publish_post",
      targetAccount: "x:hilbras",
      input: {},
    });
    expect(after).toEqual({ kind: "allow" });
  });

  it("denies a step whose approval was already refused", async () => {
    // In practice the resume path settles these before the gate is reached, so
    // this is the layer that makes the answer right without depending on that.
    const userId = await seedUser("gate_refused");
    await approvalStore.setPolicy(userId, "tool", "publish_post", "approval");
    const { runId, stepId } = await seedPublishRun(userId);
    const asked = await approvalStore.requestApproval(request(userId, runId, stepId));
    await approvalStore.decideApproval({ approvalId: asked.id, userId, decision: "rejected" });

    const after = await approvalStore.createApprovalGate(userId)({
      runId,
      stepId,
      tool: "publish_post",
      targetAccount: "x:hilbras",
      input: {},
    });
    expect(after.kind === "deny" && after.error.code).toBe("approval_rejected");
  });
});

// ---------------------------------------------------------------------------

describe("deciding", () => {
  it("publishes what the approval recorded, not what the step's column says", async () => {
    // What was approved is what publishes, and the only way that is true is if
    // the value handed to the executor comes from the approval row. The step's
    // own `input` column is deliberately different here — it is the plan's
    // record, and the person saw something else.
    const userId = await seedUser("decide_publish");
    await approvalStore.setPolicy(userId, "tool", "publish_post", "approval");
    const { runId, stepId } = await seedPublishRun(userId, {
      input: { text: "the plan's own words" },
    });

    const asked = await approvalStore.requestApproval(
      request(userId, runId, stepId, { input: { text: "the words the person read" } }),
    );
    const decided = await approvalStore.decideApproval({
      approvalId: asked.id,
      userId,
      decision: "approved",
    });
    expect(decided.ok).toBe(true);
    expect(decided.ok && decided.changed).toEqual([]);
    expect(decided.ok && decided.input).toEqual({ text: "the words the person read" });

    const { connector, calls } = recordingConnector();
    const result = await executor.executeStep(
      {
        id: stepId,
        runId,
        capability: "publish_post",
        targetAccount: "x:hilbras",
        input: JSON.stringify(decided.ok ? decided.input : {}),
        idempotencyKey: "k",
      },
      userId,
      {
        resolveConnector: () => connector,
        approval: approvalStore.createApprovalGate(userId),
      },
    );

    expect(result.state).toBe("completed");
    expect(calls).toEqual([{ text: "the words the person read" }]);
  });

  it("persists an edit and publishes the edited words", async () => {
    const userId = await seedUser("decide_edit");
    await approvalStore.setPolicy(userId, "tool", "publish_post", "approval");
    const { runId, stepId } = await seedPublishRun(userId, {
      input: { text: "the drafted words" },
    });

    const asked = await approvalStore.requestApproval(request(userId, runId, stepId));
    const decided = await approvalStore.decideApproval({
      approvalId: asked.id,
      userId,
      decision: "approved",
      edit: { text: "what the person actually wanted to say" },
    });

    expect(decided.ok).toBe(true);
    expect(decided.ok && decided.changed).toEqual(["text"]);

    const { connector, calls } = recordingConnector();
    await executor.executeStep(
      { id: stepId, runId, capability: "publish_post", targetAccount: "x:hilbras", input: JSON.stringify(decided.ok ? decided.input : {}), idempotencyKey: "k" },
      userId,
      { resolveConnector: () => connector, approval: approvalStore.createApprovalGate(userId) },
    );

    expect(calls).toEqual([{ text: "what the person actually wanted to say" }]);
    const events = await eventsOf(runId);
    expect(events.map((e) => e.event)).toContain("approval.approved");
    expect(JSON.parse(events.find((e) => e.event === "approval.approved")!.detail ?? "{}"))
      .toMatchObject({ edited: ["text"] });
  });

  it("holds an edit to the target platform's limit", async () => {
    // `text`'s declared `maxChars` is 20,000. Without the platform's own limit an
    // approver could approve 2,400 characters for X and only learn it when the
    // platform refused — after they had said yes.
    const userId = await seedUser("decide_limit");
    await approvalStore.setPolicy(userId, "tool", "publish_post", "approval");
    const { runId, stepId } = await seedPublishRun(userId);
    const asked = await approvalStore.requestApproval(request(userId, runId, stepId));

    const decided = await approvalStore.decideApproval({
      approvalId: asked.id,
      userId,
      decision: "approved",
      edit: { text: "a".repeat(400) },
    });

    expect(decided.ok).toBe(false);
    expect(!decided.ok && decided.code).toBe("invalid_edit");
    expect(!decided.ok && decided.issues?.join(" ")).toContain("this platform allows 280");

    // And nothing was decided, so the question is still open.
    expect((await approvalStore.getStepApproval(stepId))?.state).toBe("pending");
  });

  it("uses a platform's real limit, so a 400-character post is fine on Instagram", async () => {
    const userId = await seedUser("decide_limit_ig");
    await approvalStore.setPolicy(userId, "tool", "publish_post", "approval");
    const { runId, stepId } = await seedPublishRun(userId, { account: "instagram:hilbras" });
    const asked = await approvalStore.requestApproval(
      request(userId, runId, stepId, { targetAccount: "instagram:hilbras" }),
    );

    const decided = await approvalStore.decideApproval({
      approvalId: asked.id,
      userId,
      decision: "approved",
      edit: { text: "a".repeat(400) },
    });
    expect(decided.ok).toBe(true);
  });

  it("refuses an edit to a field the tool does not let a person change", async () => {
    const userId = await seedUser("decide_media");
    await approvalStore.setPolicy(userId, "tool", "publish_post", "approval");
    const { runId, stepId } = await seedPublishRun(userId);
    const asked = await approvalStore.requestApproval(request(userId, runId, stepId));

    const decided = await approvalStore.decideApproval({
      approvalId: asked.id,
      userId,
      decision: "approved",
      edit: { mediaUrl: "https://example.invalid/x.png" },
    });

    expect(!decided.ok && decided.code).toBe("invalid_edit");
    expect((await approvalStore.getStepApproval(stepId))?.state).toBe("pending");
  });

  it("refuses an edit that is really a reference to another step", async () => {
    // Valid *plan* input, and `validateToolInput` rightly accepts one. But an
    // edit is a literal, and this is the one thing the approval screen must not
    // be able to do: point the publish at some other step's output.
    const userId = await seedUser("decide_ref");
    await approvalStore.setPolicy(userId, "tool", "publish_post", "approval");
    const { runId, stepId } = await seedPublishRun(userId);
    const asked = await approvalStore.requestApproval(request(userId, runId, stepId));

    const decided = await approvalStore.decideApproval({
      approvalId: asked.id,
      userId,
      decision: "approved",
      edit: { text: { $ref: { step: 0, field: "text" } } },
    });

    expect(!decided.ok && decided.code).toBe("invalid_edit");
    expect(!decided.ok && decided.issues?.join(" ")).toContain("must be plain text");
  });

  it("refuses an edit on a rejection", async () => {
    const userId = await seedUser("decide_edit_reject");
    await approvalStore.setPolicy(userId, "tool", "publish_post", "approval");
    const { runId, stepId } = await seedPublishRun(userId);
    const asked = await approvalStore.requestApproval(request(userId, runId, stepId));

    const decided = await approvalStore.decideApproval({
      approvalId: asked.id,
      userId,
      decision: "rejected",
      edit: { text: "actually, on reflection" },
    });

    expect(!decided.ok && decided.code).toBe("invalid_edit");
    expect((await approvalStore.getStepApproval(stepId))?.state).toBe("pending");
  });

  it("will not let one user answer another's approval", async () => {
    // The ids are the only thing between one user's approval and another user's
    // post, so this check is the authorization and it is not optional.
    const owner = await seedUser("decide_owner");
    const stranger = await seedUser("decide_stranger");
    await approvalStore.setPolicy(owner, "tool", "publish_post", "approval");
    const { runId, stepId } = await seedPublishRun(owner);
    const asked = await approvalStore.requestApproval(request(owner, runId, stepId));

    const decided = await approvalStore.decideApproval({
      approvalId: asked.id,
      userId: stranger,
      decision: "approved",
    });

    expect(decided).toMatchObject({ ok: false, code: "forbidden" });
    expect((await approvalStore.getStepApproval(stepId))?.state).toBe("pending");
  });

  it("will not let a second answer overwrite the first", async () => {
    // Two people who both believed they were first. The second must not
    // silently change the content.
    const userId = await seedUser("decide_twice");
    await approvalStore.setPolicy(userId, "tool", "publish_post", "approval");
    const { runId, stepId } = await seedPublishRun(userId);
    const asked = await approvalStore.requestApproval(request(userId, runId, stepId));

    expect(
      (await approvalStore.decideApproval({ approvalId: asked.id, userId, decision: "approved" })).ok,
    ).toBe(true);
    const second = await approvalStore.decideApproval({
      approvalId: asked.id,
      userId,
      decision: "rejected",
    });

    expect(second).toMatchObject({ ok: false, code: "already_decided" });
    expect((await approvalStore.getStepApproval(stepId))?.state).toBe("approved");
  });

  it("reports a decision on an approval that does not exist", async () => {
    const userId = await seedUser("decide_missing");
    const decided = await approvalStore.decideApproval({
      approvalId: randomUUID(),
      userId,
      decision: "approved",
    });
    expect(decided).toMatchObject({ ok: false, code: "not_found" });
  });
});

// ---------------------------------------------------------------------------

describe("the window closing", () => {
  it("refuses a late answer, and closes the question by writing", async () => {
    // A window only exists if something writes to it. A deadline enforced only by
    // the reader is a deadline a user can always answer the day after.
    const userId = await seedUser("expire_late");
    await approvalStore.setPolicy(userId, "tool", "publish_post", "approval");
    const { runId, stepId } = await seedPublishRun(userId);
    const asked = await approvalStore.requestApproval(
      request(userId, runId, stepId, { now: new Date("2026-09-28T09:00:00Z") }),
    );

    const decided = await approvalStore.decideApproval({
      approvalId: asked.id,
      userId,
      decision: "approved",
      now: new Date("2026-09-29T09:00:00.001Z"),
    });

    expect(decided).toMatchObject({ ok: false, code: "approval_expired" });
    expect((await approvalStore.getStepApproval(stepId))?.state).toBe("expired");
    expect((await eventsOf(runId)).map((e) => e.event)).toContain("approval.expired");
  });

  it("accepts an answer up to the deadline and refuses one at it", async () => {
    // The window closes *at* the deadline, so at the deadline it is closed. A
    // caller can then state "answerable until T" without having to add "or just
    // after" — and the reader and the sweeper's query use the same boundary, so a
    // decision cannot be refused by one and published by the other.
    const userId = await seedUser("expire_edge");
    const openedAt = new Date("2026-09-28T09:00:00Z");
    const deadline = new Date("2026-09-29T09:00:00Z");

    const inside = await seedPublishRun(userId);
    const onTheDot = await seedPublishRun(userId);
    const insideApproval = await approvalStore.requestApproval(
      request(userId, inside.runId, inside.stepId, { now: openedAt }),
    );
    const onTheDotApproval = await approvalStore.requestApproval(
      request(userId, onTheDot.runId, onTheDot.stepId, { now: openedAt }),
    );
    expect(insideApproval.expiresAt.toISOString()).toBe(deadline.toISOString());

    const oneMillisecondEarly = await approvalStore.decideApproval({
      approvalId: insideApproval.id,
      userId,
      decision: "approved",
      now: new Date(deadline.getTime() - 1),
    });
    expect(insideApproval.expiresAt.getTime() - 1).toBeLessThan(deadline.getTime());
    expect(oneMillisecondEarly.ok).toBe(true);

    const exactlyOnTime = await approvalStore.decideApproval({
      approvalId: onTheDotApproval.id,
      userId,
      decision: "approved",
      now: deadline,
    });
    expect(exactlyOnTime).toMatchObject({ ok: false, code: "approval_expired" });
  });

  it("expires what nobody answered, and leaves a live question alone", async () => {
    const userId = await seedUser("expire_sweep");
    const stale = await seedPublishRun(userId);
    const fresh = await seedPublishRun(userId);
    const staleApproval = await approvalStore.requestApproval(
      request(userId, stale.runId, stale.stepId, { now: new Date("2026-09-20T09:00:00Z") }),
    );
    await approvalStore.requestApproval(request(userId, fresh.runId, fresh.stepId));

    const expired = await approvalStore.expireOverdueApprovals(new Date("2026-09-28T12:00:00Z"));

    // The sweeper is global — it is every user's overdue question, and scoping it
    // would leave exactly the stranded one it exists to close unexpired. So the
    // assertion is about this user's rows.
    expect(
      expired.filter((approval) => approval.runId === stale.runId).map((a) => a.id),
    ).toEqual([staleApproval.id]);
    expect((await approvalStore.getStepApproval(stale.stepId))?.state).toBe("expired");
    expect((await approvalStore.getStepApproval(fresh.stepId))?.state).toBe("pending");
  });

  it("refuses a late answer that the sweeper has not reached yet", async () => {
    // The reader closes the question too, not just the sweeper. If only the
    // sweeper did it, a user answering an hour late would be told the post was
    // still waiting while the deadline had long passed — and which of the two
    // paths a decision met would depend on the order two independent statements
    // happened to run in.
    const userId = await seedUser("expire_race");
    const { runId, stepId } = await seedPublishRun(userId);
    const asked = await approvalStore.requestApproval(
      request(userId, runId, stepId, { now: new Date("2026-09-20T09:00:00Z") }),
    );

    const decided = await approvalStore.decideApproval({
      approvalId: asked.id,
      userId,
      decision: "approved",
      now: new Date("2026-09-28T12:00:00Z"),
    });

    expect(decided).toMatchObject({ ok: false, code: "approval_expired" });
    expect((await approvalStore.getStepApproval(stepId))?.state).toBe("expired");
  });

  it("lists a user's open questions and nothing else", async () => {
    const userId = await seedUser("expire_pending");
    const open = await seedPublishRun(userId);
    const answered = await seedPublishRun(userId);
    const openApproval = await approvalStore.requestApproval(request(userId, open.runId, open.stepId));
    const closedApproval = await approvalStore.requestApproval(request(userId, answered.runId, answered.stepId));
    await approvalStore.decideApproval({ approvalId: closedApproval.id, userId, decision: "approved" });

    const pending = await approvalStore.listPendingApprovals(userId);
    expect(pending.map((a) => a.id)).toEqual([openApproval.id]);
  });
  it("claims a step exactly once, and only from the state it was in", async () => {
    // Two invocations can reach the same step — the scheduler's and the resume's
    // — and both would dispatch a publish. Reading the state and then updating it
    // is not the same thing: the gap between the two is wide enough for both to
    // see `awaiting_approval` and both to act. The step's idempotency key would
    // not save it either, since that only helps connectors which implement the
    // cache, and not all of them do.
    const userId = await seedUser("claim_once");
    const { runId, stepId } = await seedPublishRun(userId);

    expect(await runtimeService.claimStep(stepId, "pending")).toBe(true);
    expect(await runtimeService.claimStep(stepId, "pending")).toBe(false);
    expect(await runtimeService.claimStep(stepId, "awaiting_approval")).toBe(false);

    const [row] = await stepsOf(runId);
    expect(row.state).toBe("running");
  });

  it("hands the claim back to the state the step was in", async () => {
    // A claim is a reservation, and a reserved step nobody finishes is `running`
    // forever — in-progress to the lease logic, settled by nobody. Returning it to
    // the *original* state rather than to `failed` is what makes the queue's retry
    // a clean second look: a step left failed would be skipped as terminal and the
    // run would report success having published nothing.
    const userId = await seedUser("claim_release");
    const { runId, stepId } = await seedPublishRun(userId);
    await runtimeService.claimStep(stepId, "pending");

    await runtimeService.releaseStepClaim(runId, stepId, "pending", {
      message: "the gate could not be reached",
    });

    const [row] = await stepsOf(runId);
    expect(row.state).toBe("pending");
    // And the claim is available again, which is the whole point.
    expect(await runtimeService.claimStep(stepId, "pending")).toBe(true);
  });

  it("does not hand back a claim it does not hold", async () => {
    // Two invocations, one crashed: the release must not reach a step the other
    // one has since taken, or it would be returned to the pool while running.
    const userId = await seedUser("claim_not_held");
    const { runId, stepId } = await seedPublishRun(userId);

    await runtimeService.releaseStepClaim(runId, stepId, "pending", { message: "x" });

    const [row] = await stepsOf(runId);
    expect(row.state).toBe("pending");
    expect((await eventsOf(runId)).map((e) => e.event)).not.toContain(
      "step.claim_released",
    );
  });

  it("does not let a second invocation take a step that is still running", async () => {
    // The one thing a claim has to be.
    //
    // `claimStep` was a compare-and-swap from whatever state the caller *read*,
    // and the caller reads the live row. So a step observed as `running` could be
    // "claimed" from `running` to `running` — and the queue is at-least-once, so
    // a redelivery of the same event lands in a second invocation while the first
    // is still inside the step body. Both would execute it, and both would
    // publish. The idempotency key does not save it: that only helps connectors
    // which implement the receipt cache, and not all of them do.
    //
    // v0.8.0 tested "claims a step exactly once" by claiming twice *from
    // `pending`*. It never claimed from `running`, which is the only state a
    // concurrent invocation ever observes.
    const userId = await seedUser("claim_running");
    const { stepId } = await seedPublishRun(userId);

    expect(await runtimeService.claimStep(stepId, "pending")).toBe(true);
    // A second invocation reading the live row sees `running`, and asks to claim
    // from `running`. It must be refused.
    expect(await runtimeService.claimStep(stepId, "running")).toBe(false);
  });

  it("reclaims a step whose worker never came back", async () => {
    // The other half of the same rule, and the reason the refusal above is not
    // simply "a running step is forever". `releaseStepClaim` runs in a `catch`,
    // which a worker killed outright never reaches — so a claim needs a lease,
    // not just a flag. Without one, refusing a `running` step would convert a
    // double-execution bug into a permanently stuck run.
    const userId = await seedUser("claim_lease");
    const { stepId } = await seedPublishRun(userId);

    const claimedAt = new Date("2026-09-29T10:00:00Z");
    expect(await runtimeService.claimStep(stepId, "pending", claimedAt)).toBe(true);

    // Just inside the lease: the holder is presumed alive.
    const justInside = new Date(claimedAt.getTime() + runtimeService.STEP_CLAIM_LEASE_MS - 1);
    expect(await runtimeService.claimStep(stepId, "running", justInside)).toBe(false);

    // Past it: the worker is presumed gone, and the step is recoverable.
    const justOutside = new Date(claimedAt.getTime() + runtimeService.STEP_CLAIM_LEASE_MS + 1);
    expect(await runtimeService.claimStep(stepId, "running", justOutside)).toBe(true);
  });

  it("does not treat a non-running step as having a stale claim", async () => {
    // The lease applies to `running` and nothing else. A `pending` step whose
    // `startedAt` is old is not stale — it has never been claimed — and must stay
    // claimable, or a long-old plan could never run.
    const userId = await seedUser("claim_not_running");
    const { stepId } = await seedPublishRun(userId);

    const longAgo = new Date("2020-01-01T00:00:00Z");
    expect(await runtimeService.claimStep(stepId, "pending", longAgo)).toBe(true);
  });
});

/**
 * v0.9.5 (Phase 8): `runs.error_summary` was declared in v0.5.0, selected by
 * `queries.ts`, typed in two DTOs, and rendered in a panel on the run detail
 * page — and nothing ever wrote it. A failed run showed an empty error box.
 *
 * The reason was that the `fail` event carried no reason: `transitionRun` knows
 * only *that* a run failed, while the code that fails it knows why. So the reason
 * is now carried on the event, which is the only place both can meet.
 */
describe("why a run failed", () => {
  it("records the reason the caller supplied", async () => {
    const userId = await seedUser("error_summary_set");
    const { runId } = await seedPublishRun(userId);

    await runtimeService.transitionRun(runId, { type: "start" });
    await runtimeService.transitionRun(runId, {
      type: "fail",
      summary: "X rejected the post: duplicate content",
    });

    const [row] = await testDb.select().from(runs).where(eq(runs.id, runId));
    expect(row!.errorSummary).toBe("X rejected the post: duplicate content");
    expect(row!.state).toBe("failed");
  });

  it("leaves it null when the caller has nothing to add", async () => {
    // Two of the three failure sites genuinely have no prose to offer, and a
    // manufactured message would be worse than an honest blank.
    const userId = await seedUser("error_summary_absent");
    const { runId } = await seedPublishRun(userId);

    await runtimeService.transitionRun(runId, { type: "start" });
    await runtimeService.transitionRun(runId, { type: "fail" });

    const [row] = await testDb.select().from(runs).where(eq(runs.id, runId));
    expect(row!.errorSummary).toBeNull();
  });

  it("leaves it null on a run that succeeded", async () => {
    // The summary describes how a run ended. A run that ended well did not fail,
    // so a `succeed` must not clear or invent one.
    const userId = await seedUser("error_summary_success");
    const { runId } = await seedPublishRun(userId);

    await runtimeService.transitionRun(runId, { type: "start" });
    await runtimeService.transitionRun(runId, { type: "succeed" });

    const [row] = await testDb.select().from(runs).where(eq(runs.id, runId));
    expect(row!.errorSummary).toBeNull();
    expect(row!.state).toBe("completed");
  });

  it("reaches the run detail screen", async () => {
    // The end of the chain. Asserted through the owner-scoped read layer rather
    // than straight from the table, because that layer is what the page uses and
    // a column that is written but not selected is still an empty panel.
    const userId = await seedUser("error_summary_query");
    const { runId } = await seedPublishRun(userId);

    await runtimeService.transitionRun(runId, { type: "start" });
    await runtimeService.transitionRun(runId, {
      type: "fail",
      summary: "Threads rejected the post: media already published",
    });

    const detail = await runtimeQueries.getRunDetail(userId, runId);
    expect(detail?.run.errorSummary).toBe(
      "Threads rejected the post: media already published",
    );

    // And it is scoped like everything else in that module (ADR-008). The
    // contract is "no row for you" rather than an error — an owner-scoped read
    // that threw would let a caller distinguish *exists but not yours* from
    // *does not exist*, which is a slow way to confirm an id is real.
    const otherUser = await seedUser("error_summary_other");
    expect(await runtimeQueries.getRunDetail(otherUser, runId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("not losing a suspension", () => {
  /**
   * The sweeper's work list, narrowed to one run.
   *
   * `listApprovalsNeedingResume` is global by design — it is every user's stuck
   * suspension, and scoping it would leave exactly the stranded run it exists to
   * find unclaimed. So a test that counts its rows would be counting the other
   * tests in this file, which share one database. Narrowing here keeps the
   * assertions about *this* run's behaviour.
   */
  const resumeIdsFor = async (runId: string) =>
    (await approvalStore.listApprovalsNeedingResume())
      .filter((approval) => approval.runId === runId)
      .map((approval) => approval.id);

  it("finds a decision whose step is still waiting", async () => {
    // The crash window: the person said yes, and the message telling the queue
    // never arrived. Without this query the run is suspended forever next to an
    // approved post, and nothing else would ever look at it again.
    const userId = await seedUser("stuck_run");
    const { runId, stepId } = await seedPublishRun(userId);
    const asked = await approvalStore.requestApproval(request(userId, runId, stepId));
    await approvalStore.decideApproval({ approvalId: asked.id, userId, decision: "approved" });

    await testDb.update(runSteps).set({ state: "awaiting_approval" }).where(eq(runSteps.id, stepId));
    await testDb.update(runs).set({ state: "awaiting_approval" }).where(eq(runs.id, runId));

    expect(await resumeIdsFor(runId)).toEqual([asked.id]);
  });

  it("stops listing it once the step has moved on", async () => {
    // The convergence rule: a decision is "picked up" exactly when the step it
    // was about stops being `awaiting_approval`. Without this the sweeper would
    // re-send a resume for every suspended run on every tick forever.
    const userId = await seedUser("picked_up");
    const { runId, stepId } = await seedPublishRun(userId);
    const asked = await approvalStore.requestApproval(request(userId, runId, stepId));
    await approvalStore.decideApproval({ approvalId: asked.id, userId, decision: "approved" });

    await testDb.update(runSteps).set({ state: "awaiting_approval" }).where(eq(runSteps.id, stepId));
    await testDb.update(runs).set({ state: "awaiting_approval" }).where(eq(runs.id, runId));
    expect(await resumeIdsFor(runId)).toEqual([asked.id]);

    await testDb.update(runSteps).set({ state: "completed" }).where(eq(runSteps.id, stepId));
    expect(await resumeIdsFor(runId)).toEqual([]);
  });

  it("does not re-list a run that is waiting on a *different* step's question", async () => {
    // Otherwise one long-suspended run collects a resume every five minutes for
    // the whole window, and each one walks the whole plan for nothing.
    const userId = await seedUser("second_question");
    const { runId, stepId } = await seedPublishRun(userId);
    const first = await approvalStore.requestApproval(request(userId, runId, stepId));
    await approvalStore.decideApproval({ approvalId: first.id, userId, decision: "approved" });

    // A later step of the same run is now the one being asked about.
    const secondStepId = randomUUID();
    await testDb.insert(runSteps).values({
      id: secondStepId,
      runId,
      stepIndex: 1,
      label: "Publish to Instagram",
      capability: "publish_post",
      targetAccount: "instagram:hilbras",
      state: "awaiting_approval",
      input: JSON.stringify({ text: "second" }),
      idempotencyKey: `${runId}:1:instagram:hilbras`,
    });
    const second = await approvalStore.requestApproval(
      request(userId, runId, secondStepId, { targetAccount: "instagram:hilbras" }),
    );
    await approvalStore.decideApproval({
      approvalId: second.id,
      userId,
      decision: "approved",
    });
    await testDb.update(runs).set({ state: "awaiting_approval" }).where(eq(runs.id, runId));
    await testDb.update(runSteps).set({ state: "completed" }).where(eq(runSteps.id, stepId));

    expect(await resumeIdsFor(runId)).toEqual([second.id]);
  });

  it("does not re-list a run that was stopped while it waited", async () => {
    // A run the user cancelled is finished. Re-sending a resume for it every tick
    // forever would be a queue that cannot be shut down.
    const userId = await seedUser("cancelled_run");
    const { runId, stepId } = await seedPublishRun(userId);
    const asked = await approvalStore.requestApproval(request(userId, runId, stepId));
    await approvalStore.decideApproval({ approvalId: asked.id, userId, decision: "approved" });

    await testDb.update(runSteps).set({ state: "awaiting_approval" }).where(eq(runSteps.id, stepId));
    await testDb.update(runs).set({ state: "cancelled" }).where(eq(runs.id, runId));

    expect(await resumeIdsFor(runId)).toEqual([]);
  });

  it("does not re-list a question nobody has answered", async () => {
    // A resume for a pending approval would find nothing to do, but sending it
    // anyway means every open question wakes a run on every tick.
    const userId = await seedUser("unanswered");
    const { runId, stepId } = await seedPublishRun(userId);
    await approvalStore.requestApproval(request(userId, runId, stepId));

    await testDb.update(runSteps).set({ state: "awaiting_approval" }).where(eq(runSteps.id, stepId));
    await testDb.update(runs).set({ state: "awaiting_approval" }).where(eq(runs.id, runId));

    expect(await resumeIdsFor(runId)).toEqual([]);
  });
});
