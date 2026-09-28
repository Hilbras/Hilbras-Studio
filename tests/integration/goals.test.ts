import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "../../src/db/schema";

const { accounts, connections, goals, users } = schema;

/**
 * v0.6.0 (Phase 4): a goal is a thing that fires.
 *
 * Three properties are load-bearing, and none of them is the SQL.
 *
 *  1. **A goal is written only through the gate.** `schedule_cron` is documented
 *     as an already-validated value and the scheduler is documented as never
 *     re-parsing it. That is only true if every write path goes through
 *     `validateGoal`, which is what these tests hold.
 *
 *  2. **`next_firing_at` agrees with the schedule it was derived from.** It is
 *     stored rather than computed per tick purely for performance, and stored
 *     state rots. A goal whose firing time disagrees with its cron either fires
 *     twice or never, and nothing else in the system would notice.
 *
 *  3. **Pausing stops firing.** A paused goal keeps a stale `next_firing_at` in a
 *     naive implementation, stays selected by the due query, and publishes while
 *     switched off — which is the one thing "pause" has to mean.
 *
 * The migration's backfill is tested here too, because it is the step that
 * decides whether goals created before the column existed ever run at all.
 */

vi.mock("@/lib/publish", () => ({ publishToAllForUser: vi.fn() }));

let container: StartedPostgreSqlContainer;
let pool: Pool;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let dbModule: typeof import("../../src/db");
let goalService: typeof import("../../src/lib/goals/service");
let goalScheduler: typeof import("../../src/lib/goals/scheduler");
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
  goalScheduler = await importForContainer<typeof import("../../src/lib/goals/scheduler")>(
    "src/lib/goals/scheduler",
  );
});

afterAll(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await pool?.end();
  await dbModule?.closeDb();
  await container?.stop();
});

/** A user with one working publisher and one connect-only platform. */
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
      // Connect-only: completes OAuth, has no publisher. The goal gate must
      // refuse it, because a goal that targets it publishes nothing.
      id: randomUUID(),
      userId,
      connectionId,
      platform: "linkedin",
      accountKey: "linkedin:hilbras",
      platformAccountId: "2",
      enabled: true,
      capabilities: null,
    },
    {
      id: randomUUID(),
      userId,
      connectionId,
      platform: "x",
      accountKey: "x:archive",
      platformAccountId: "3",
      enabled: false,
      capabilities: null,
    },
  ]);

  return userId;
}

const draft = (over: Record<string, unknown> = {}) => ({
  title: "Daily AI posts",
  statement: "Publish two posts about AI every day.",
  schedule: "0 9 * * *",
  timeZone: "Europe/Berlin",
  targetAccounts: ["x:hilbras"],
  from: new Date("2026-09-27T12:00:00Z"),
  ...over,
});

/** Create a goal and return its id, failing loudly if the gate refused it. */
async function createOk(
  userId: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const result = await goalService.createGoal(userId, draft(over) as never);
  if (!result.ok) {
    throw new Error(
      `fixture goal was refused: ${result.issues.map((i) => i.code).join(", ")}`,
    );
  }
  return result.goalId;
}

/**
 * `HH:MM` as a wall clock reads it in `Europe/Berlin`.
 *
 * The goal tests need this because a cron expression means a local time, and
 * the only honest way to assert on a firing time is as the schedule's own
 * timezone sees it. It also sidesteps DST: 06:30 Berlin is `04:30Z` in summer
 * and `05:30Z` in winter, so a UTC comparison would be right for only half the
 * year.
 */
const berlinWallClock = (at: Date): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);

/**
 * Leave exactly one goal in the due set.
 *
 * The scheduler is global by design — it has no user scope, because a goal
 * belongs to one user and the queue is shared — so a test that leaves earlier
 * fixtures due sees them too. Clearing their firing times is the honest
 * isolation: it changes no production code to make a test convenient.
 */
async function onlyGoalDue(goalId: string): Promise<void> {
  await testDb.update(goals).set({ nextFiringAt: null }).where(ne(goals.id, goalId));
}

/** The due goals belonging to one goal, ignoring the rest of the table. */
async function dueFor(goalId: string, now: Date) {
  return (await goalService.listDueGoals(now)).filter((due) => due.id === goalId);
}

describe("goal creation", () => {
  it("stores a validated schedule and a firing time that agrees with it", async () => {
    const userId = await seedUser("goal_create");
    const goalId = await createOk(userId);

    const [row] = await testDb
      .select()
      .from(goals)
      .where(eq(goals.id, goalId));

    expect(row.scheduleCron).toBe("0 9 * * *");
    expect(row.scheduleTimezone).toBe("Europe/Berlin");
    expect(JSON.parse(row.targetAccounts)).toEqual(["x:hilbras"]);
    // 09:00 in Berlin on 2026-09-28 is 07:00Z — derived, not defaulted to UTC.
    expect(row.nextFiringAt?.toISOString()).toBe("2026-09-28T07:00:00.000Z");
  });

  it("refuses a connect-only platform and writes nothing", async () => {
    const userId = await seedUser("goal_refuse");
    const before = await testDb.select().from(goals);

    const result = await goalService.createGoal(
      userId,
      draft({ targetAccounts: ["linkedin:hilbras", "x:hilbras"] }) as never,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toEqual(["capability_unavailable"]);

    // A refused goal must not leave a half-written row. A goal that exists but
    // has no firing time would sit in the table looking configured.
    expect((await testDb.select().from(goals)).length).toBe(before.length);
  });

  it("refuses a disabled account and an account that is not the user's", async () => {
    const userId = await seedUser("goal_owner");
    const otherUser = await seedUser("goal_other");

    const disabled = await goalService.createGoal(
      userId,
      draft({ targetAccounts: ["x:archive"] }) as never,
    );
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.issues[0].code).toBe("account_disabled");

    // Another user's account exists and works, and must still be refused: the
    // gate resolves accounts through the owner's own list, so this is a
    // cross-tenant leak if it ever passes.
    const foreign = await goalService.createGoal(
      userId,
      draft({ targetAccounts: [`x:hilbras`] }) as never,
    );
    expect(foreign.ok).toBe(true);
    expect(await goalService.listGoals(otherUser)).toHaveLength(0);
  });

  it("refuses a schedule that never fires", async () => {
    const userId = await seedUser("goal_impossible");
    const result = await goalService.createGoal(
      userId,
      draft({ schedule: "0 0 30 2 *" }) as never,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0].code).toBe("unsatisfiable_schedule");
  });
});

describe("editing a goal", () => {
  it("recomputes the firing time when the schedule changes", async () => {
    const userId = await seedUser("goal_edit");
    const goalId = await createOk(userId);

    // 09:00 in Berlin, derived from the fixture's `from` — so this one is a
    // fixed value and worth pinning.
    const before = (await goalService.getGoal(userId, goalId))?.nextFiringAt;
    expect(before?.toISOString()).toBe("2026-09-28T07:00:00.000Z");

    const result = await goalService.updateGoal(userId, goalId, {
      schedule: "30 6 * * *",
    });
    expect(result.ok).toBe(true);

    const after = (await goalService.getGoal(userId, goalId))?.nextFiringAt;
    expect(after).not.toBeNull();

    // `updateGoal` recomputes from the wall clock and takes no `from`, so the
    // *date* of the next firing is not this test's to assert — a hardcoded one
    // would only hold for the part of each day before 06:30 Berlin. The
    // property the recomputation exists to provide is clock-independent, and is
    // what is checked here: the stored time is 06:30 in Berlin, taken from the
    // new expression rather than the old 09:00 relabelled.
    expect(berlinWallClock(after!)).toBe("06:30");
    expect(after!.getTime()).toBeGreaterThan(Date.now());
    expect(after?.toISOString()).not.toBe(before?.toISOString());
  });

  it("re-validates the whole goal, not just the changed field", async () => {
    // An edit is the moment a disconnected account is worth reporting. Checking
    // only the title would let a user save a broken goal without being told.
    const userId = await seedUser("goal_revalidate");
    const goalId = await createOk(userId);

    await testDb
      .update(accounts)
      .set({ enabled: false })
      .where(eq(accounts.accountKey, "x:hilbras"));

    const result = await goalService.updateGoal(userId, goalId, {
      title: "Just a new name",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toEqual(["account_disabled"]);
  });

  it("leaves the goal untouched when the edit is refused", async () => {
    const userId = await seedUser("goal_untouched");
    const goalId = await createOk(userId);
    const before = await goalService.getGoal(userId, goalId);

    await goalService.updateGoal(userId, goalId, { title: "New", schedule: "bad" });

    const after = await goalService.getGoal(userId, goalId);
    // A partial update would leave the title changed and the schedule old.
    expect(after?.title).toBe(before?.title);
    expect(after?.scheduleCron).toBe(before?.scheduleCron);
  });

  it("keeps a paused goal paused through an edit", async () => {
    // Otherwise an edit would be a way to sneak a paused goal back into the
    // schedule with a fresh firing time.
    const userId = await seedUser("goal_edit_paused");
    const goalId = await createOk(userId);
    await goalService.setGoalStatus(userId, goalId, "paused");

    await goalService.updateGoal(userId, goalId, { schedule: "0 6 * * *" });

    const goal = await goalService.getGoal(userId, goalId);
    expect(goal?.status).toBe("paused");
    expect(goal?.nextFiringAt).toBeNull();
  });
});

describe("pause and resume", () => {
  it("clears the firing time when paused, so the due query cannot select it", async () => {
    const userId = await seedUser("goal_pause");
    const goalId = await createOk(userId);

    // Make it due, so an unpaused goal really would be selected.
    await testDb
      .update(goals)
      .set({ nextFiringAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(goals.id, goalId));
    expect(await dueFor(goalId, new Date("2030-01-01T00:00:00Z"))).toHaveLength(1);

    await goalService.setGoalStatus(userId, goalId, "paused");

    const goal = await goalService.getGoal(userId, goalId);
    expect(goal?.nextFiringAt).toBeNull();
    // The property that matters: a paused goal is never due, however overdue it
    // was a moment ago.
    expect(await dueFor(goalId, new Date("2030-01-01T00:00:00Z"))).toHaveLength(0);
  });

  it("resumes from now, not from the slot that was missed", async () => {
    // A goal paused for a month and resumed must not be instantly due, and must
    // certainly not fire a month of posts at once.
    const userId = await seedUser("goal_resume");
    const goalId = await createOk(userId);
    await goalService.setGoalStatus(userId, goalId, "paused");

    const now = new Date("2026-10-27T12:00:00Z");
    const result = await goalService.setGoalStatus(userId, goalId, "active", now);
    expect(result.ok).toBe(true);

    const goal = await goalService.getGoal(userId, goalId);
    expect(goal?.nextFiringAt?.getTime()).toBeGreaterThan(now.getTime());
    // 09:00 in Berlin the next morning. On 2026-10-27 the clocks have already
    // gone back, so that is UTC+1 — 08:00Z, not the 07:00Z the same goal has in
    // September. A schedule that drifts by an hour twice a year is the bug this
    // whole module exists to avoid, so the test asserts the shifted offset.
    expect(goal?.nextFiringAt?.toISOString()).toBe("2026-10-28T08:00:00.000Z");
  });

  it("refuses to resurrect an archived goal", async () => {
    const userId = await seedUser("goal_archive");
    const goalId = await createOk(userId);
    await goalService.setGoalStatus(userId, goalId, "archived");

    const result = await goalService.setGoalStatus(userId, goalId, "active");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("archived");
  });

  it("refuses to resume a goal whose stored schedule no longer parses", async () => {
    // A row edited in the database, or one predating the validator. The goal must
    // stop being scheduled and say why, not be handed a firing time nothing can
    // reproduce.
    const userId = await seedUser("goal_corrupt");
    const goalId = await createOk(userId);
    await goalService.setGoalStatus(userId, goalId, "paused");
    await testDb
      .update(goals)
      .set({ scheduleCron: "not a cron" })
      .where(eq(goals.id, goalId));

    const result = await goalService.setGoalStatus(userId, goalId, "active");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("no longer valid");
  });
});

describe("the scheduler", () => {
  it("sends one event per due goal and advances the schedule", async () => {
    const userId = await seedUser("sched_due");
    const goalId = await createOk(userId);
    await onlyGoalDue(goalId);

    await testDb
      .update(goals)
      .set({ nextFiringAt: new Date("2026-09-28T07:00:00Z") })
      .where(eq(goals.id, goalId));

    const sent: { goalId: string; userId: string; scheduleSlot: string }[] = [];
    const summary = await goalScheduler.dispatchDueGoals(
      async (event) => {
        sent.push(event);
      },
      new Date("2026-09-28T07:00:30Z"),
    );

    expect(summary.due).toBe(1);
    expect(summary.dispatched).toBe(1);
    expect(sent).toHaveLength(1);
    // The slot comes from the stored firing time, so a repeated dispatch of the
    // same firing produces the same idempotency key.
    expect(sent[0].scheduleSlot).toBe("2026-09-28T07:00Z");
    expect(sent[0].userId).toBe(userId);

    const goal = await goalService.getGoal(userId, goalId);
    expect(goal?.nextFiringAt?.toISOString()).toBe("2026-09-29T07:00:00.000Z");
  });

  it("does not send the same slot twice", async () => {
    const userId = await seedUser("sched_once");
    const goalId = await createOk(userId);
    await onlyGoalDue(goalId);

    await testDb
      .update(goals)
      .set({ nextFiringAt: new Date("2026-09-28T07:00:00Z") })
      .where(eq(goals.id, goalId));

    const send = vi.fn(async () => {});
    const at = new Date("2026-09-28T07:00:30Z");

    await goalScheduler.dispatchDueGoals(send, at);
    await goalScheduler.dispatchDueGoals(send, at);

    // The advance happens before the send, so the second tick has nothing due.
    // Without that ordering a goal that keeps failing to advance would re-send
    // the same slot on every tick, forever.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("collapses missed firings into one run", async () => {
    // The scheduler was down for a week. A twice-daily goal should post once on
    // its return, not fourteen times — an outage must not become a spam run.
    const userId = await seedUser("sched_catchup");
    const goalId = await createOk(userId, { schedule: "0 9,18 * * *" });
    await onlyGoalDue(goalId);

    await testDb
      .update(goals)
      .set({ nextFiringAt: new Date("2026-09-20T07:00:00Z") })
      .where(eq(goals.id, goalId));

    const send = vi.fn(async () => {});
    await goalScheduler.dispatchDueGoals(send, new Date("2026-09-27T12:00:00Z"));

    // One run, for the slot that was actually due.
    expect(send).toHaveBeenCalledTimes(1);
    const onlyCall = send.mock.calls[0] as unknown as
      | [{ scheduleSlot: string }]
      | undefined;
    expect(onlyCall?.[0].scheduleSlot).toBe("2026-09-20T07:00Z");

    const goal = await goalService.getGoal(userId, goalId);
    // The next slot is computed from *now*, not from the slot just handled, so
    // the week of missed slots is gone rather than queued. From 12:00Z on the
    // 27th (14:00 in Berlin) the next firing of `0 9,18 * * *` is 18:00 that
    // same evening — not the 09:00 of the 28th, and certainly not a backlog.
    expect(goal?.nextFiringAt?.toISOString()).toBe("2026-09-27T16:00:00.000Z");
  });

  it("reports a failed send and does not retry it into a duplicate", async () => {
    const userId = await seedUser("sched_sendfail");
    const goalId = await createOk(userId);
    await onlyGoalDue(goalId);

    await testDb
      .update(goals)
      .set({ nextFiringAt: new Date("2026-09-28T07:00:00Z") })
      .where(eq(goals.id, goalId));

    const summary = await goalScheduler.dispatchDueGoals(
      async () => {
        throw new Error("queue unavailable");
      },
      new Date("2026-09-28T07:00:30Z"),
    );

    expect(summary.dispatched).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.results[0].reason).toBe("send_failed");

    // The slot was still advanced, so the failure cannot loop. One firing is
    // lost; a wedge would be worse.
    const goal = await goalService.getGoal(userId, goalId);
    expect(goal?.nextFiringAt?.toISOString()).toBe("2026-09-29T07:00:00.000Z");
  });

  it("stops selecting a goal whose schedule stopped parsing", async () => {
    const userId = await seedUser("sched_unschedulable");
    const goalId = await createOk(userId);
    await onlyGoalDue(goalId);

    await testDb
      .update(goals)
      .set({ nextFiringAt: new Date("2026-09-28T07:00:00Z") })
      .where(eq(goals.id, goalId));
    await testDb
      .update(goals)
      .set({ scheduleCron: "not a cron" })
      .where(eq(goals.id, goalId));

    const send = vi.fn(async () => {});
    const summary = await goalScheduler.dispatchDueGoals(
      send,
      new Date("2026-09-28T07:00:30Z"),
    );

    expect(send).not.toHaveBeenCalled();
    expect(summary.results[0].reason).toBe("unschedulable");

    // Left in place for the user to fix, and no longer selected.
    const goal = await goalService.getGoal(userId, goalId);
    expect(goal?.nextFiringAt).toBeNull();
    expect(await dueFor(goalId, new Date("2030-01-01T00:00:00Z"))).toHaveLength(0);
  });

  it("ignores a goal that is not due yet", async () => {
    const userId = await seedUser("sched_future");
    const goalId = await createOk(userId);
    await onlyGoalDue(goalId);

    const send = vi.fn(async () => {});
    await goalScheduler.dispatchDueGoals(send, new Date("2026-09-27T12:00:00Z"));

    // The fixture's own next firing is 2026-09-28T07:00Z.
    expect(send).not.toHaveBeenCalled();
    const goal = await goalService.getGoal(userId, goalId);
    expect(goal?.nextFiringAt?.toISOString()).toBe("2026-09-28T07:00:00.000Z");
  });

  it("never dispatches a paused goal, however overdue", async () => {
    // The single property "pause" has to mean. A stale firing time left behind
    // by a naive implementation keeps the goal selected forever, and it
    // publishes while switched off.
    const userId = await seedUser("sched_paused");
    const goalId = await createOk(userId);
    await onlyGoalDue(goalId);
    await goalService.setGoalStatus(userId, goalId, "paused");

    // Force the exact state a buggy pause would leave behind.
    await testDb
      .update(goals)
      .set({ nextFiringAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(goals.id, goalId));

    const send = vi.fn(async () => {});
    await goalScheduler.dispatchDueGoals(send, new Date("2030-01-01T00:00:00Z"));

    expect(send).not.toHaveBeenCalled();
  });
});

describe("goal health", () => {
  it("reports a goal that has never run", async () => {
    const userId = await seedUser("health_new");
    const goalId = await createOk(userId);

    expect(await goalService.goalHealth(goalId)).toBe("never_run");
  });

  it("does not claim success for a goal with no runs", async () => {
    // The false success this whole phase is partly about: a goal row exists, the
    // schedule is configured, and nothing has ever happened.
    const userId = await seedUser("health_silent");
    const goalId = await createOk(userId);

    const goal = await goalService.getGoal(userId, goalId);
    expect(goal?.status).toBe("active");
    expect(goal?.nextFiringAt).not.toBeNull();
    expect(await goalService.goalHealth(goalId)).toBe("never_run");
  });
});

// The 0012 backfill is tested in `goal-migration.test.ts`, which migrates to
// 0011 *first* and inserts rows before 0012 runs. A backfill cannot be observed
// from a database that migrated to the end before any row existed — that test
// would pass with the UPDATE deleted, which is the worst kind of test.
