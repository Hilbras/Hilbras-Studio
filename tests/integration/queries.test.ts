import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../../src/db/schema";

const { accounts, connections, goals, runEvents, runStepApprovals, runSteps, runs, users } =
  schema;

/**
 * v0.9.0 (Phase 7): the read models a screen is allowed to use.
 *
 * `runtime/service.ts` has readers that are deliberately unscoped — `getRun`,
 * `listRunSteps`, `listRunEvents` — because the executor and the resume path are
 * handed a `runId` by the queue and cannot ask whose run it is. Those are the
 * right functions for the Runtime and the wrong ones for a page: `getRun`
 * answers "does this run exist", and a screen that renders what it gets will
 * show one tenant's plan, step input, and connector errors to another tenant.
 *
 * `runtime/queries.ts` exists to make that unreachable, and the only way to know
 * it works is to run two users against one database. So these tests are almost
 * entirely about separation, plus the handful of places where a read could lie
 * about state:
 *
 *  1. **Nothing crosses a tenant boundary.** Runs, run details, goals, and
 *     approvals each stay with their owner, and a *known* id belonging to
 *     someone else is `null` rather than an error.
 *  2. **A `goalId` filter cannot be used to read another tenant's runs.** The
 *     scope is the run's own `userId`, not a lookup of the goal first.
 *  3. **The dashboard's numbers are the caller's numbers.** Every count, list
 *     and "blocked" verdict is derived under the same scope as everything else.
 *  4. **A suspended run shows the question it is actually blocked on.** The run
 *     state and the approval row are written by two different statements, and
 *     the approval is settled first — so a page reading the state alone would
 *     render a question that has already been answered.
 *  5. **"Overdue" counts what is about to fail, not what already has.** A
 *     dashboard reporting `expired: 0` while four approvals are past their
 *     deadline is the cheerful lie this count exists to prevent.
 *  6. **A goal that cannot act is visible without a failed run.** It is the one
 *     Runtime problem that never appears in the history, because no run is
 *     created.
 *  7. **A limit cannot be asked past the cap.**
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let dbModule: typeof import("../../src/db");
let queries: typeof import("../../src/lib/runtime/queries");
let goalService: typeof import("../../src/lib/goals/service");
let runtimeService: typeof import("../../src/lib/runtime/service");
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
  queries = await importForContainer<typeof import("../../src/lib/runtime/queries")>(
    "src/lib/runtime/queries",
  );
  goalService = await importForContainer<typeof import("../../src/lib/goals/service")>(
    "src/lib/goals/service",
  );
  runtimeService = await importForContainer<
    typeof import("../../src/lib/runtime/service")
  >("src/lib/runtime/service");
});

afterAll(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await pool?.end();
  await dbModule?.closeDb();
  await container?.stop();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Distinguishes the user rows `seedUser` creates; see the comment there. */
let userCount = 0;

/**
 * A user with one enabled X account and one disabled Instagram account.
 *
 * The account keys are the readable `prefix`, so a test can name `x:bob`
 * without holding the id. `users.email` and `users.username` are globally
 * unique, though, and most tests seed `"alice"` and `"bob"` more than once, so
 * the user row carries a per-call suffix. Only the user row needs it: account
 * keys are unique per `(userId, accountKey)`, not globally, so two seeded
 * `"alice"`s may each own `x:alice` without colliding.
 */
async function seedUser(prefix: string): Promise<string> {
  const suffix = userCount++;
  const userId = randomUUID();
  await testDb.insert(users).values({
    id: userId,
    name: `${prefix} ${suffix}`,
    email: `${prefix}-${suffix}@example.invalid`,
    username: `${prefix}-${suffix}`,
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
      accountKey: `x:${prefix}`,
      platformAccountId: "1",
      enabled: true,
      capabilities: null,
    },
    {
      id: randomUUID(),
      userId,
      connectionId,
      platform: "instagram",
      accountKey: `instagram:${prefix}`,
      platformAccountId: "2",
      // Off, so a goal naming it is blocked — which is what the "will not fire"
      // count is about.
      enabled: false,
      capabilities: null,
    },
  ]);

  prefixOf.set(userId, prefix);

  return userId;
}

/**
 * The account prefix each seeded user owns, so a fixture can name that user's
 * own accounts without threading a prefix through every call.
 *
 * `seedRun` needs a real account key: `createGoal` runs the goal gate, which
 * refuses a target the user does not own, so `x:nobody` would make every
 * fixture that wanted a healthy goal fail for the wrong reason. The map is
 * populated by `seedUser` and is the only reason `seedRun` can pick a target
 * the caller did not spell out.
 */
const prefixOf = new Map<string, string>();

/** A goal with a run, two steps, and two events. */
async function seedRun(
  userId: string,
  over: { targetAccounts?: string[] } = {},
): Promise<{ userId: string; goalId: string; runId: string }> {
  const prefix = prefixOf.get(userId);
  if (prefix === undefined) {
    throw new Error("seedRun was called with a user seedUser did not create");
  }

  const created = await goalService.createGoal(userId, {
    title: "Daily AI commentary",
    statement: "Post every morning about something in AI worth reading.",
    schedule: "0 9 * * *",
    timeZone: "Europe/Berlin",
    targetAccounts: over.targetAccounts ?? [`x:${prefix}`],
    from: new Date("2026-09-27T12:00:00Z"),
  } as never);
  if (!created.ok) {
    throw new Error(
      `fixture goal refused: ${created.issues.map((i) => i.code).join(", ")}`,
    );
  }

  const run = await runtimeService.createRun({
    goalId: created.goalId,
    // A distinct slot per run. `createRun` is idempotent on (goal, slot), so a
    // reused slot would be absorbed as a redelivery and two fixtures would
    // quietly share one run — which is exactly the kind of thing that makes a
    // row-counting test pass for the wrong reason.
    scheduleSlot: `2026-09-28T07:00:00Z-${randomUUID().slice(0, 8)}`,
  });
  if (!run.created) throw new Error("fixture run was not created");

  await testDb.insert(runSteps).values([
    {
      id: randomUUID(),
      runId: run.runId,
      stepIndex: 0,
      label: "Write the post",
      capability: "compose_post",
      state: "completed",
      input: JSON.stringify({ brief: "something in AI" }),
      result: JSON.stringify({ text: "A post about AI." }),
      idempotencyKey: `k-${randomUUID()}`,
    },
    {
      id: randomUUID(),
      runId: run.runId,
      stepIndex: 1,
      label: "Publish to X",
      capability: "publish_post",
      targetAccount: `x:${prefix}`,
      state: "pending",
      idempotencyKey: `k-${randomUUID()}`,
    },
  ]);

  await testDb.insert(runEvents).values([
    {
      id: randomUUID(),
      runId: run.runId,
      level: "info",
      event: "run.started",
      at: new Date("2026-09-28T07:00:00Z"),
    },
    {
      id: randomUUID(),
      runId: run.runId,
      level: "info",
      event: "step.completed",
      at: new Date("2026-09-28T07:00:01Z"),
    },
  ]);

  return { userId, goalId: created.goalId, runId: run.runId };
}

/**
 * An approval on a run's step, with a window that closes at `expiresAt`.
 *
 * State is a parameter rather than always `pending` because two of the
 * properties worth holding are about rows that are *not* the live one: a run
 * asked twice needs the newest pending question found and the expired one
 * ignored, and an approval that is already expired must not be counted as
 * pending by the dashboard.
 */
async function seedApproval(
  runId: string,
  userId: string,
  stepIndex: number,
  expiresAt: Date,
  state: "pending" | "approved" | "expired" = "pending",
): Promise<string> {
  const [step] = await testDb
    .select({ id: runSteps.id, targetAccount: runSteps.targetAccount })
    .from(runSteps)
    .where(and(eq(runSteps.runId, runId), eq(runSteps.stepIndex, stepIndex)))
    .limit(1);
  if (!step) throw new Error("fixture run has no step at that index to approve");

  const id = randomUUID();
  await testDb.insert(runStepApprovals).values({
    id,
    runId,
    stepId: step.id,
    userId,
    tool: "publish_post",
    targetAccount: step.targetAccount,
    input: JSON.stringify({ text: "A post about AI." }),
    state,
    expiresAt,
  });

  return id;
}

// ---------------------------------------------------------------------------
// 1 & 2 — Nothing crosses a tenant boundary
// ---------------------------------------------------------------------------

describe("runs are scoped to their owner", () => {
  it("lists only the caller's runs", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    await seedRun(alice);
    await seedRun(bob);
    await seedRun(bob);

    const aliceRuns = await queries.listRuns(alice);
    expect(aliceRuns).toHaveLength(1);
    expect(aliceRuns[0].goalTitle).toBe("Daily AI commentary");

    const bobRuns = await queries.listRuns(bob);
    expect(bobRuns).toHaveLength(2);
  });

  it("returns null for another user's run, rather than an error", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const { runId } = await seedRun(bob);

    // Not an error and not a 403-shaped result: the two are the same answer,
    // and distinguishing them would confirm that a guessed id exists.
    expect(await queries.getRunDetail(alice, runId)).toBeNull();
    expect(await queries.getRunDetail(bob, runId)).not.toBeNull();
  });

  it("returns null for a run that does not exist at all", async () => {
    const alice = await seedUser("alice");
    expect(await queries.getRunDetail(alice, randomUUID())).toBeNull();
  });

  it("cannot be widened by a goalId belonging to someone else", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const { goalId } = await seedRun(bob);

    // A `goalId` filter narrows; it never widens. Bob's goal matches no runs
    // under Alice's scope, because the scope is the run's own `userId` and not
    // a lookup of the goal first.
    expect(await queries.listRuns(alice, { goalId })).toHaveLength(0);
  });

  it("carries step content only to the run's owner", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const { runId } = await seedRun(bob);

    const detail = await queries.getRunDetail(bob, runId);
    expect(detail?.steps).toHaveLength(2);
    // The run log is where "what actually went out" is answered, which is the
    // reason the content is in the detail shape at all.
    expect(detail?.steps[0].input).toContain("brief");
    // The fixture writes `run.started` and `step.completed`; `createRun` has
    // already written `run.created`. Asserting on the names rather than the count
    // keeps the test honest if `createRun` gains a log line of its own.
    expect(detail?.events.map((event) => event.event)).toEqual(
      expect.arrayContaining(["run.created", "run.started", "step.completed"]),
    );

    // And the summary a list renders carries none of it.
    const [summary] = await queries.listRuns(bob);
    expect(summary).not.toHaveProperty("input");
    expect(summary).not.toHaveProperty("result");
    expect(await queries.getRunDetail(alice, runId)).toBeNull();
  });

  it("counts steps, so a list need not read the plan", async () => {
    const bob = await seedUser("bob");
    await seedRun(bob);
    const [summary] = await queries.listRuns(bob);
    expect(summary.stepCount).toBe(2);
  });

  it("reports zero steps for a run that was never planned", async () => {
    const bob = await seedUser("bob");
    const goal = await goalService.createGoal(bob, {
      title: "Never planned",
      statement: "This one has no plan.",
      schedule: "0 9 * * *",
      timeZone: "UTC",
      targetAccounts: ["x:bob"],
      from: new Date("2026-09-27T12:00:00Z"),
    } as never);
    if (!goal.ok) throw new Error("fixture goal refused");

    const run = await runtimeService.createRun({
      goalId: goal.goalId,
      scheduleSlot: `bare-${randomUUID()}`,
    });
    if (!run.created) throw new Error("fixture run was not created");

    const [summary] = await queries.listRuns(bob);
    // `0`, not a missing key. A list row that needs a null check to render is a
    // list row that will eventually be rendered as "undefined steps".
    expect(summary.stepCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3 — The dashboard's numbers are the caller's numbers
// ---------------------------------------------------------------------------

describe("the runtime overview is scoped", () => {
  it("counts only the caller's goals, runs, approvals, and accounts", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    await seedRun(alice);
    await seedRun(bob);
    await seedRun(bob);
    await seedApproval((await seedRun(bob)).runId, bob, 1, new Date("2099-01-01T00:00:00Z"));

    const aliceView = await queries.getRuntimeOverview(alice);
    expect(aliceView.goals.total).toBe(1);
    expect(aliceView.recentRuns).toHaveLength(1);
    expect(aliceView.approvals.pending).toBe(0);
    expect(aliceView.accounts.total).toBe(2);

    const bobView = await queries.getRuntimeOverview(bob);
    expect(bobView.goals.total).toBe(3);
    expect(bobView.recentRuns).toHaveLength(3);
    expect(bobView.approvals.pending).toBe(1);
  });

  it("separates in-flight work from finished work", async () => {
    const bob = await seedUser("bob");
    const { runId } = await seedRun(bob);

    // pending | running are in flight; awaiting_approval is not, because the
    // run is holding a question rather than doing anything, and a user reading
    // "in flight: 2" when one of them is waiting for them is being misinformed.
    await testDb
      .update(runs)
      .set({ state: "running" })
      .where(eq(runs.id, runId));
    expect((await queries.getRuntimeOverview(bob)).runs.inFlight).toBe(1);

    await testDb
      .update(runs)
      .set({ state: "awaiting_approval" })
      .where(eq(runs.id, runId));
    const view = await queries.getRuntimeOverview(bob);
    expect(view.runs.inFlight).toBe(0);
    expect(view.runs.awaitingApproval).toBe(1);
  });

  it("counts a failed run inside the week and not outside it", async () => {
    const bob = await seedUser("bob");
    const { runId } = await seedRun(bob);
    // Three days back, comfortably inside `RECENT_WINDOW_MS` of 7 days. A
    // date just past the boundary would test the window's exact width, which
    // is a number this file does not own; the point is that a window exists.
    await testDb
      .update(runs)
      .set({ state: "failed", createdAt: new Date("2026-09-25T00:00:00Z") })
      .where(eq(runs.id, runId));

    const now = new Date("2026-09-28T12:00:00Z");
    const inside = await queries.getRuntimeOverview(bob, now);
    expect(inside.runs.recentFailed).toBe(1);

    // The same failure, read a month later, is outside the window. "Failed this
    // week" is only true if the window is real.
    const later = await queries.getRuntimeOverview(bob, new Date("2026-10-28T12:00:00Z"));
    expect(later.runs.recentFailed).toBe(0);
    expect(later.runs.recent).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4 — A suspended run shows the question it is blocked on
// ---------------------------------------------------------------------------

describe("the question a run is actually blocked on", () => {
  it("is found from the approval row, not inferred from the run state", async () => {
    const bob = await seedUser("bob");
    const { runId } = await seedRun(bob);
    const approvalId = await seedApproval(
      runId,
      bob,
      1,
      new Date("2099-01-01T00:00:00Z"),
    );

    await testDb
      .update(runs)
      .set({ state: "awaiting_approval" })
      .where(eq(runs.id, runId));

    const detail = await queries.getRunDetail(bob, runId);
    expect(detail?.pendingApproval?.id).toBe(approvalId);
    expect(detail?.pendingApproval?.input).toEqual({ text: "A post about AI." });
  });

  it("disappears once the question is answered, even though the run is still suspended", async () => {
    const bob = await seedUser("bob");
    const { runId } = await seedRun(bob);
    const approvalId = await seedApproval(
      runId,
      bob,
      1,
      new Date("2099-01-01T00:00:00Z"),
    );
    await testDb
      .update(runs)
      .set({ state: "awaiting_approval" })
      .where(eq(runs.id, runId));

    // The window between the decision and the resume that acts on it. The run
    // is still `awaiting_approval`; the question is gone. A page reading the
    // state alone would render an answered question with a live Approve button.
    await testDb
      .update(runStepApprovals)
      .set({ state: "approved", decidedAt: new Date("2026-09-28T08:00:00Z") })
      .where(eq(runStepApprovals.id, approvalId));

    const detail = await queries.getRunDetail(bob, runId);
    expect(detail?.run.state).toBe("awaiting_approval");
    expect(detail?.pendingApproval).toBeNull();
  });

  it("shows the newest pending question when a run has been asked more than once", async () => {
    const bob = await seedUser("bob");
    const { runId } = await seedRun(bob);

    await seedApproval(runId, bob, 0, new Date("2099-01-01T00:00:00Z"), "expired");
    const live = await seedApproval(runId, bob, 1, new Date("2099-06-01T00:00:00Z"));

    const detail = await queries.getRunDetail(bob, runId);
    expect(detail?.pendingApproval?.id).toBe(live);
  });

  it("is not shown to another user", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const { runId } = await seedRun(bob);
    await seedApproval(runId, bob, 1, new Date("2099-01-01T00:00:00Z"));

    expect(await queries.getRunDetail(alice, runId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5 — "Overdue" counts what is about to fail
// ---------------------------------------------------------------------------

describe("overdue approvals", () => {
  it("are counted from the deadline, not from the state", async () => {
    const bob = await seedUser("bob");
    const now = new Date("2026-09-28T12:00:00Z");

    const past = await seedRun(bob);
    await seedApproval(past.runId, bob, 1, new Date("2026-09-28T11:00:00Z"));
    const future = await seedRun(bob);
    await seedApproval(future.runId, bob, 1, new Date("2026-09-29T11:00:00Z"));

    const view = await queries.getRuntimeOverview(bob, now);
    expect(view.approvals.pending).toBe(2);
    // One of the two cannot be answered any more, and the sweeper may be up to
    // five minutes from turning `expired` into a number. Reporting `0` here is
    // the cheerful lie the count exists to prevent.
    expect(view.approvals.overdue).toBe(1);
  });

  it("does not count an already-expired approval as pending", async () => {
    const bob = await seedUser("bob");
    const { runId } = await seedRun(bob);
    await seedApproval(
      runId,
      bob,
      1,
      new Date("2026-09-20T00:00:00Z"),
      "expired",
    );

    const view = await queries.getRuntimeOverview(bob, new Date("2026-09-28T12:00:00Z"));
    expect(view.approvals.pending).toBe(0);
    expect(view.approvals.overdue).toBe(0);
  });

  it("agrees with the boundary the store enforces", async () => {
    // The count uses `expires_at <= now` and `isOverdue` uses `now >= expiresAt`.
    // These are the same comparison, and the test is at the boundary rather than
    // near it, because a sampled test only catches an error at least a sample wide.
    const bob = await seedUser("bob");
    const { runId } = await seedRun(bob);
    const deadline = new Date("2026-09-28T12:00:00Z");
    await seedApproval(runId, bob, 1, deadline);

    const { isOverdue } = await importForContainer<
      typeof import("../../src/lib/runtime/approvals")
    >("src/lib/runtime/approvals");

    const before = await queries.getRuntimeOverview(
      bob,
      new Date(deadline.getTime() - 1),
    );
    expect(before.approvals.overdue).toBe(
      isOverdue(deadline, new Date(deadline.getTime() - 1)) ? 1 : 0,
    );

    const at = await queries.getRuntimeOverview(bob, deadline);
    expect(at.approvals.overdue).toBe(
      isOverdue(deadline, deadline) ? 1 : 0,
    );
    expect(at.approvals.overdue).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6 — A goal that cannot act is visible without a failed run
// ---------------------------------------------------------------------------

describe("a goal that will not fire", () => {
  // Every test here saves the goal against a *working* account and breaks the
  // account afterwards. `createGoal` refuses a goal whose target is already
  // disabled or cannot publish, so a goal in this state is only reachable by
  // someone switching the account off afterwards — which is the whole point:
  // the goal stays in the schedule, nothing errors, and it simply goes quiet.

  it("is counted when a target account is switched off", async () => {
    const bob = await seedUser("bob");
    await seedRun(bob, { targetAccounts: ["x:bob"] });
    await testDb
      .update(accounts)
      .set({ enabled: false })
      .where(eq(accounts.accountKey, "x:bob"));

    const view = await queries.getRuntimeOverview(bob);
    expect(view.goals.active).toBe(1);
    expect(view.blockedGoals).toBe(1);
  });

  it("is not counted when every target can publish", async () => {
    const bob = await seedUser("bob");
    await seedRun(bob, { targetAccounts: ["x:bob"] });
    expect((await queries.getRuntimeOverview(bob)).blockedGoals).toBe(0);
  });

  it("is counted when a target cannot publish, even if it is switched on", async () => {
    const bob = await seedUser("bob");
    await seedRun(bob, { targetAccounts: ["x:bob"] });
    // Switched on, but its stored capability set lacks `publish_post`. The
    // account is written with an explicit set rather than left to fall back to
    // the platform registry, so the refusal belongs to the account itself.
    await testDb
      .update(accounts)
      .set({ enabled: true, capabilities: JSON.stringify(["read_metrics"]) })
      .where(eq(accounts.accountKey, "x:bob"));

    expect((await queries.getRuntimeOverview(bob)).blockedGoals).toBe(1);
  });

  it("is not counted for a paused goal, which is not meant to fire", async () => {
    const bob = await seedUser("bob");
    const { goalId } = await seedRun(bob, { targetAccounts: ["x:bob"] });
    await testDb
      .update(accounts)
      .set({ enabled: false })
      .where(eq(accounts.accountKey, "x:bob"));
    await testDb.update(goals).set({ status: "paused" }).where(eq(goals.id, goalId));

    // Reporting a paused goal as blocked would be noise: a paused goal not
    // firing is the reason it was paused.
    expect((await queries.getRuntimeOverview(bob)).blockedGoals).toBe(0);
  });

  it("is zero for a user with no goals at all", async () => {
    const nobody = await seedUser("nobody");
    expect((await queries.getRuntimeOverview(nobody)).blockedGoals).toBe(0);
  });

  it("does not count another user's blocked goal", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    await seedRun(bob, { targetAccounts: ["x:bob"] });
    await testDb
      .update(accounts)
      .set({ enabled: false })
      .where(and(eq(accounts.accountKey, "x:bob"), eq(accounts.userId, bob)));

    expect((await queries.getRuntimeOverview(bob)).blockedGoals).toBe(1);
    expect((await queries.getRuntimeOverview(alice)).blockedGoals).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7 — A limit cannot be asked past the cap
// ---------------------------------------------------------------------------

describe("list limits", () => {
  it("clamps a limit rather than trusting it", () => {
    expect(queries.clampLimit(undefined, 25)).toBe(25);
    expect(queries.clampLimit(10, 25)).toBe(10);
    expect(queries.clampLimit(0, 25)).toBe(1);
    expect(queries.clampLimit(-5, 25)).toBe(1);
    expect(queries.clampLimit(1e9, 25)).toBe(queries.MAX_LIST_LIMIT);
    expect(queries.clampLimit(Number.NaN, 25)).toBe(25);
    // A fractional limit would be passed to `LIMIT` as a float and round at the
    // database rather than here, which is a different number from the one the
    // caller asked for.
    expect(queries.clampLimit(7.9, 25)).toBe(7);
  });

  it("returns no more than the cap when asked for more", async () => {
    const bob = await seedUser("bob");
    for (let i = 0; i < 3; i++) await seedRun(bob);

    const runs = await queries.listRuns(bob, { limit: 1e9 });
    expect(runs.length).toBeLessThanOrEqual(queries.MAX_LIST_LIMIT);
  });
});
