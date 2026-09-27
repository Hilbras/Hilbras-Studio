import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../../src/db/schema";

const { accounts, connections, runEvents, runSteps, runs, users } = schema;

/**
 * v0.7.0 (Phase 5): a goal statement becomes a plan that can execute.
 *
 * The unit tests cover the gate, the reference resolver, and the parser. What
 * they cannot cover is the half that decides whether a *firing* works, and that
 * is where the properties worth holding live:
 *
 *  1. **A refused plan writes nothing at all.** `runs.plan` and `run_steps` are
 *     written in one transaction, so a run cannot reach execution carrying a
 *     plan it does not have steps for. A half-written plan is the state no
 *     reader here is prepared for.
 *
 *  2. **A step's idempotency key is derived, not supplied.** The planner never
 *     sees it, and a plan that publishes twice to one account has to produce two
 *     keys — otherwise the second is absorbed as a duplicate of the first and
 *     the user gets one post where they asked for two.
 *
 *  3. **The planner is never asked when the goal cannot be planned.** A
 *     disconnected account is a fact the system knows; spending a model call to
 *     be told it back is a call that produces nothing and hides the real
 *     reason.
 *
 *  4. **Re-planning cannot overwrite a run's steps.** The queue is
 *     at-least-once, and a redelivered planning step must not change what a run
 *     is about to publish (ADR-005).
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let dbModule: typeof import("../../src/db");
let goalService: typeof import("../../src/lib/goals/service");
let runtimeService: typeof import("../../src/lib/runtime/service");
let planning: typeof import("../../src/lib/runtime/planning");
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
  planning = await importForContainer<
    typeof import("../../src/lib/runtime/planning")
  >("src/lib/runtime/planning");
});

afterAll(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await pool?.end();
  await dbModule?.closeDb();
  await container?.stop();
});

/** A user with two publishing accounts and one connect-only platform. */
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
    {
      id: randomUUID(),
      userId,
      connectionId,
      platform: "linkedin",
      accountKey: "linkedin:hilbras",
      platformAccountId: "3",
      enabled: true,
      capabilities: null,
    },
    {
      id: randomUUID(),
      userId,
      connectionId,
      platform: "x",
      accountKey: "x:muted",
      platformAccountId: "4",
      enabled: false,
      capabilities: null,
    },
  ]);

  return userId;
}

const draft = (over: Record<string, unknown> = {}) => ({
  title: "Daily AI commentary",
  statement: "Post every morning about something in AI worth reading.",
  schedule: "0 9 * * *",
  timeZone: "Europe/Berlin",
  targetAccounts: ["x:hilbras"],
  from: new Date("2026-09-27T12:00:00Z"),
  ...over,
});

/** A goal that the gate accepts, or the test fails with the reason. */
async function createGoal(
  userId: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const result = await goalService.createGoal(userId, draft(over) as never);
  if (!result.ok) {
    throw new Error(
      `fixture goal refused: ${result.issues.map((i) => i.code).join(", ")}`,
    );
  }
  return result.goalId;
}

/** A run in `pending`, created through the service so its key is real. */
async function createRunFor(goalId: string, slot: string): Promise<string> {
  const result = await runtimeService.createRun({
    goalId,
    scheduleSlot: slot,
  });
  if (!result.created) throw new Error("fixture run was not created");
  return result.runId;
}

/** A `Completer` that returns each reply in turn and records what it was sent. */
function scripted(...replies: string[]) {
  const calls: { system: string; user: string }[] = [];
  let index = 0;
  const complete = async (system: string, user: string) => {
    calls.push({ system, user });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return reply;
  };
  return { complete, calls };
}

const planJson = (steps: unknown) => JSON.stringify({ steps });

/** The pipeline the planner is asked for: one draft and one publish per account. */
function pipelineFor(accounts: string[]) {
  return accounts.flatMap((account) => [
    {
      label: `Draft for ${account}`,
      capability: "compose_post",
      targetAccount: account,
      input: { brief: "one concrete reason weekly beats monthly" },
    },
    {
      label: `Publish to ${account}`,
      capability: "publish_post",
      targetAccount: account,
      input: { text: { $ref: { step: accounts.indexOf(account) * 2, field: "text" } } },
    },
  ]);
}

const runStepsOf = (runId: string) =>
  testDb.select().from(runSteps).where(eq(runSteps.runId, runId));

const eventsOf = (runId: string) =>
  testDb.select().from(runEvents).where(eq(runEvents.runId, runId));

describe("planRun", () => {
  it("turns a statement into persisted steps, references intact", async () => {
    const userId = await seedUser("plan_ok");
    const goalId = await createGoal(userId, {
      targetAccounts: ["x:hilbras", "instagram:hilbras"],
    });
    const runId = await createRunFor(goalId, "2026-09-28T07:00Z");

    const { complete, calls } = scripted(
      planJson(pipelineFor(["x:hilbras", "instagram:hilbras"])),
    );
    const result = await planning.planRun(runId, { complete });

    expect(result.ok).toBe(true);
    expect(result.ok && result.stepCount).toBe(4);
    expect(result.ok && result.attempts).toBe(1);
    expect(result.ok && result.repaired).toBe(false);

    const steps = await runStepsOf(runId);
    expect(steps.map((s) => s.stepIndex)).toEqual([0, 1, 2, 3]);
    expect(steps.every((s) => s.state === "pending")).toBe(true);

    // The reference is stored unresolved: the plan stays self-describing, and a
    // replayed step reproduces its input rather than inventing a new one.
    expect(JSON.parse(steps[1].input ?? "{}")).toEqual({
      text: { $ref: { step: 0, field: "text" } },
    });
    expect(calls[0].user).toContain("Post every morning about something in AI");
  });

  it("records the plan on the run, and in the run's history", async () => {
    const userId = await seedUser("plan_recorded");
    const goalId = await createGoal(userId);
    const runId = await createRunFor(goalId, "2026-09-28T07:00Z");

    await planning.planRun(runId, {
      complete: scripted(planJson(pipelineFor(["x:hilbras"]))).complete,
    });

    const [run] = await testDb.select().from(runs).where(eq(runs.id, runId));
    expect(JSON.parse(run.plan ?? "null")).toMatchObject({
      steps: expect.any(Array),
    });

    const events = await eventsOf(runId);
    expect(events.map((e) => e.event)).toContain("plan.created");
  });

  it("derives each step's idempotency key, so a repeated target is not one step", async () => {
    // Two posts to the same account in one run is two dispatches. Without
    // stepIndex in the key the second would be absorbed as a duplicate and the
    // user would get one post where they asked for two.
    const userId = await seedUser("plan_keys");
    const goalId = await createGoal(userId);
    const runId = await createRunFor(goalId, "2026-09-28T07:00Z");

    await planning.planRun(runId, {
      complete: scripted(
        planJson([
          { label: "First", capability: "publish_post", targetAccount: "x:hilbras", input: { text: "one" } },
          { label: "Second", capability: "publish_post", targetAccount: "x:hilbras", input: { text: "two" } },
        ]),
      ).complete,
    });

    const steps = await runStepsOf(runId);
    expect(steps.map((s) => s.idempotencyKey)).toEqual([
      `run:${runId}:0:x:hilbras`,
      `run:${runId}:1:x:hilbras`,
    ]);
  });

  it("refuses a plan that skips one of the goal's accounts, and repairs it once", async () => {
    const userId = await seedUser("plan_repair");
    const goalId = await createGoal(userId, {
      targetAccounts: ["x:hilbras", "instagram:hilbras"],
    });
    const runId = await createRunFor(goalId, "2026-09-28T07:00Z");

    const { complete, calls } = scripted(
      planJson(pipelineFor(["x:hilbras"])),
      planJson(pipelineFor(["x:hilbras", "instagram:hilbras"])),
    );
    const result = await planning.planRun(runId, { complete });

    expect(result.ok).toBe(true);
    expect(result.ok && result.repaired).toBe(true);
    expect(result.ok && result.attempts).toBe(2);

    // The repair prompt carries the gate's own words, not a paraphrase.
    expect(calls[1].user).toContain("why_the_last_plan_was_refused");
    expect(calls[1].user).toContain("instagram:hilbras");

    const events = await eventsOf(runId);
    expect(events.map((e) => e.event)).toContain("plan.rejected");
    expect(events.map((e) => e.event)).toContain("plan.repaired");
  });

  it("gives up after the repair, and writes no steps at all", async () => {
    // A run that reached execution with no steps reported `completed` in
    // v0.6.0. The gate refusing twice must leave the run with nothing, not
    // with half a plan.
    const userId = await seedUser("plan_refused");
    const goalId = await createGoal(userId, {
      targetAccounts: ["x:hilbras", "instagram:hilbras"],
    });
    const runId = await createRunFor(goalId, "2026-09-28T07:00Z");

    const { complete, calls } = scripted(planJson(pipelineFor(["x:hilbras"])));
    const result = await planning.planRun(runId, { complete });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("plan_rejected");
    expect(!result.ok && result.issues?.map((i) => i.code)).toContain(
      "uncovered_goal_target",
    );
    expect(calls).toHaveLength(2);

    expect(await runStepsOf(runId)).toHaveLength(0);
    const [run] = await testDb.select().from(runs).where(eq(runs.id, runId));
    expect(run.plan).toBeNull();
  });

  it("refuses a plan naming an account the goal does not target", async () => {
    // The goal points at X. A plan that also posts to Instagram is refused,
    // even though the user does own and use that account.
    const userId = await seedUser("plan_wrong_target");
    const goalId = await createGoal(userId, { targetAccounts: ["x:hilbras"] });
    const runId = await createRunFor(goalId, "2026-09-28T07:00Z");

    const result = await planning.planRun(runId, {
      complete: scripted(
        planJson(pipelineFor(["x:hilbras", "instagram:hilbras"])),
      ).complete,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues?.map((i) => i.code)).toContain(
      "unknown_account",
    );
    expect(await runStepsOf(runId)).toHaveLength(0);
  });

  it("refuses an unreadable reply, then tries once more", async () => {
    const userId = await seedUser("plan_garbage");
    const goalId = await createGoal(userId);
    const runId = await createRunFor(goalId, "2026-09-28T07:00Z");

    const { complete, calls } = scripted(
      "Sure! Here is what I would do.",
      planJson(pipelineFor(["x:hilbras"])),
    );
    const result = await planning.planRun(runId, { complete });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].user).toContain("not a JSON object");
  });

  it("does not ask the model when a target account was switched off after the goal was saved", async () => {
    // A planner cannot fix a disconnected account. Spending a call to be told
    // the same thing back produces nothing and hides the real reason.
    //
    // The goal is created against a healthy account and the account is broken
    // afterwards, because that is the only way this state is reachable:
    // `validateGoal` refuses the goal at save time. "A goal validated today can
    // have its account disconnected tomorrow" is the whole reason planning
    // re-checks what the goal gate already checked.
    const userId = await seedUser("plan_disabled");
    const goalId = await createGoal(userId, { targetAccounts: ["x:hilbras"] });
    await testDb
      .update(accounts)
      .set({ enabled: false })
      .where(eq(accounts.accountKey, "x:hilbras"));
    const runId = await createRunFor(goalId, "2026-09-28T07:00Z");

    const { complete, calls } = scripted(planJson(pipelineFor(["x:hilbras"])));
    const result = await planning.planRun(runId, { complete });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("no_usable_target");
    expect(!result.ok && result.message).toContain("switched off");
    expect(!result.ok && result.message).toContain("Reconnect or switch the account on");
    expect(calls).toHaveLength(0);
    expect(await runStepsOf(runId)).toHaveLength(0);
    expect((await eventsOf(runId)).map((e) => e.event)).toContain(
      "plan.no_usable_target",
    );
  });

  it("does not ask the model when a target lost its publishing scope", async () => {
    // A platform revoking a scope re-resolves the account's capability set to
    // empty. The account is still connected and still enabled — it just cannot
    // publish any more, and a goal pointed at it now produces nothing forever.
    const userId = await seedUser("plan_connect_only");
    const goalId = await createGoal(userId, { targetAccounts: ["x:hilbras"] });
    await testDb
      .update(accounts)
      .set({ capabilities: JSON.stringify([]) })
      .where(eq(accounts.accountKey, "x:hilbras"));
    const runId = await createRunFor(goalId, "2026-09-28T07:00Z");

    const { complete, calls } = scripted(planJson([]));
    const result = await planning.planRun(runId, { complete });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("no_usable_target");
    expect(!result.ok && result.message).toContain("cannot publish post");
    expect(calls).toHaveLength(0);
    expect(await runStepsOf(runId)).toHaveLength(0);
  });

  it("refuses a goal whose target is unusable, at save time", async () => {
    // The counterpart to the two tests above. The goal gate and the planner
    // both check the same thing, and neither replaces the other: this one stops
    // a bad goal being created, and the two above stop an existing one firing
    // to nowhere.
    const userId = await seedUser("plan_gate_at_save");

    const disabled = await goalService.createGoal(userId, draft({
      targetAccounts: ["x:muted"],
    }) as never);
    expect(disabled.ok).toBe(false);
    expect(!disabled.ok && disabled.issues.map((i) => i.code)).toContain(
      "account_disabled",
    );

    const connectOnly = await goalService.createGoal(userId, draft({
      targetAccounts: ["linkedin:hilbras"],
    }) as never);
    expect(connectOnly.ok).toBe(false);
    expect(!connectOnly.ok && connectOnly.issues.map((i) => i.code)).toContain(
      "capability_unavailable",
    );
  });

  it("reports a model failure without asking the queue to try the slot again", async () => {
    // A provider that is merely down is worth retrying; a plan the gate refused
    // is not, because the next firing generates a fresh plan anyway.
    const userId = await seedUser("plan_provider");
    const goalId = await createGoal(userId);
    const runId = await createRunFor(goalId, "2026-09-28T07:00Z");

    let calls = 0;
    const result = await planning.planRun(runId, {
      complete: async () => {
        calls += 1;
        throw new Error("503 Service Unavailable");
      },
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("ai_unavailable");
    expect(calls).toBe(1);
    expect((await eventsOf(runId)).map((e) => e.event)).toContain(
      "plan.ai_unavailable",
    );
  });

  it("shows the planner the goal's recent firings, without the run it is planning", async () => {
    const userId = await seedUser("plan_history");
    const goalId = await createGoal(userId);

    const earlierSlot = "2026-09-26T07:00Z";
    const earlierRun = await createRunFor(goalId, earlierSlot);
    await testDb.insert(runSteps).values({
      id: randomUUID(),
      runId: earlierRun,
      stepIndex: 0,
      label: "Publish to x:hilbras",
      capability: "publish_post",
      targetAccount: "x:hilbras",
      state: "failed",
      idempotencyKey: `run:${earlierRun}:0:x:hilbras`,
    });

    const runId = await createRunFor(goalId, "2026-09-28T07:00Z");
    const { complete, calls } = scripted(planJson(pipelineFor(["x:hilbras"])));
    await planning.planRun(runId, { complete });

    const user = calls[0].user;
    expect(user).toContain(earlierSlot);
    expect(user).toContain("a step failed at publish_post");
    // The in-flight run is excluded: showing a planner "running, 0 steps" for
    // the plan it is still producing is noise at best.
    expect(user).not.toContain("2026-09-28T07:00Z");
  });
});

describe("persistPlan", () => {
  it("refuses a second write rather than replacing a run's plan", async () => {
    // The queue is at-least-once. A redelivered planning step must not change
    // the content a run is about to publish — that is the one thing the queue
    // must never be able to do (ADR-005).
    const userId = await seedUser("persist_once");
    const goalId = await createGoal(userId);
    const runId = await createRunFor(goalId, "2026-09-28T07:00Z");

    const first = await runtimeService.persistPlan(
      runId,
      { steps: [{ label: "Original" }] },
      [{ stepIndex: 0, label: "Original", capability: "publish_post", targetAccount: "x:hilbras" }],
    );
    expect(first.created).toBe(true);

    const second = await runtimeService.persistPlan(
      runId,
      { steps: [{ label: "Replacement" }] },
      [{ stepIndex: 0, label: "Replacement", capability: "publish_post", targetAccount: "x:hilbras" }],
    );
    expect(second.created).toBe(false);

    const steps = await runStepsOf(runId);
    expect(steps).toHaveLength(1);
    expect(steps[0].label).toBe("Original");

    const [run] = await testDb.select().from(runs).where(eq(runs.id, runId));
    expect(JSON.parse(run.plan ?? "{}")).toMatchObject({
      steps: [{ label: "Original" }],
    });
  });

  it("gives a step with no account a distinct key segment", async () => {
    const userId = await seedUser("persist_no_account");
    const goalId = await createGoal(userId);
    const runId = await createRunFor(goalId, "2026-09-28T07:00Z");

    expect(runtimeService.stepIdempotencyKey(runId, 0, null)).toBe(
      `run:${runId}:0:none`,
    );
    expect(runtimeService.stepIdempotencyKey(runId, 0, undefined)).toBe(
      `run:${runId}:0:none`,
    );
    expect(runtimeService.stepIdempotencyKey(runId, 0, "x:hilbras")).toBe(
      `run:${runId}:0:x:hilbras`,
    );
  });
});

describe("a planned run is executable", () => {
  it("persists the references a later step needs, and reports no steps missing", async () => {
    // The v0.6.0 defect was a run with no steps reporting success. This asserts
    // the other end of it: a planned run has steps, and they are the shape the
    // executor resolves references from.
    const userId = await seedUser("plan_executable");
    const goalId = await createGoal(userId);
    const runId = await createRunFor(goalId, "2026-09-28T07:00Z");

    await planning.planRun(runId, {
      complete: scripted(planJson(pipelineFor(["x:hilbras"]))).complete,
    });

    expect(await runtimeService.countRunSteps(runId)).toBe(2);
    const steps = await runtimeService.listRunSteps(runId);
    expect(steps[0].capability).toBe("compose_post");
    expect(steps[1].capability).toBe("publish_post");
    expect(steps[1].targetAccount).toBe("x:hilbras");
  });
});
