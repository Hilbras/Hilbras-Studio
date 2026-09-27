import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../../src/db/schema";

const { goals, runEvents, runSteps, runs, users } = schema;

/**
 * Covers the Phase 1 runtime tables against real PostgreSQL.
 *
 * The properties asserted here are the ones a unit test cannot check, because
 * they are enforced by the database rather than by TypeScript: the unique
 * constraints that make redelivery safe, and the cascades that decide what
 * survives a deleted goal.
 */
let container: StartedPostgreSqlContainer;
let pool: Pool;
let testDb: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  testDb = drizzle(pool, { schema });
  await migrate(testDb, { migrationsFolder: resolve(process.cwd(), "drizzle") });
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function seedUser(username: string): Promise<string> {
  const id = randomUUID();
  await testDb.insert(users).values({
    id,
    name: username,
    email: `${username}@example.invalid`,
    username,
    passwordHash: "not-a-real-hash",
  });
  return id;
}

describe("runtime tables", () => {
  it("stores a goal and its runs, steps, and events", async () => {
    const userId = await seedUser("runtime_owner");
    const goalId = randomUUID();
    const runId = randomUUID();
    const stepId = randomUUID();

    await testDb.insert(goals).values({
      id: goalId,
      userId,
      title: "Daily AI posts",
      statement: "Publish two AI-related posts every day",
      scheduleCron: "0 10 * * *",
      targetAccounts: JSON.stringify(["x:hilbras", "instagram:hilbras"]),
    });

    await testDb.insert(runs).values({
      id: runId,
      goalId,
      userId,
      idempotencyKey: "goal:2026-09-27T10:00Z",
      scheduleSlot: "2026-09-27T10:00Z",
    });

    await testDb.insert(runSteps).values({
      id: stepId,
      runId,
      stepIndex: 0,
      label: "Publish to X",
      capability: "publish_post",
      targetAccount: "x:hilbras",
      idempotencyKey: `${runId}:0:x:hilbras`,
      input: JSON.stringify({ text: "hello" }),
    });

    await testDb.insert(runEvents).values({
      id: randomUUID(),
      runId,
      stepId,
      level: "info",
      event: "run.started",
    });

    const [goal] = await testDb.select().from(goals).where(eq(goals.id, goalId));
    expect(goal.status).toBe("active");
    expect(goal.scheduleTimezone).toBe("UTC");
    expect(JSON.parse(goal.targetAccounts)).toEqual([
      "x:hilbras",
      "instagram:hilbras",
    ]);

    const [run] = await testDb.select().from(runs).where(eq(runs.id, runId));
    expect(run.state).toBe("pending");
    expect(run.attempt).toBe(1);

    const steps = await testDb
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, runId));
    expect(steps).toHaveLength(1);
    expect(steps[0].capability).toBe("publish_post");

    const events = await testDb
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId));
    expect(events.map((e) => e.event)).toEqual(["run.started"]);
  });



  it("rejects a duplicate run idempotency key, so redelivery cannot double-publish", async () => {
    // The queue is at-least-once. This unique constraint is the only thing
    // standing between a redelivered message and a second set of posts
    // (ADR-005) — so it must exist in the database, not just in a comment.
    const userId = await seedUser("idem_owner");
    const goalId = randomUUID();

    await testDb.insert(goals).values({
      id: goalId,
      userId,
      title: "Idempotency",
      statement: "Publish once",
      scheduleCron: "0 10 * * *",
    });

    const key = `goal:${goalId}:2026-09-27T10:00Z`;
    await testDb.insert(runs).values({
      id: randomUUID(),
      goalId,
      userId,
      idempotencyKey: key,
      scheduleSlot: "2026-09-27T10:00Z",
    });

    await expect(
      testDb.insert(runs).values({
        id: randomUUID(),
        goalId,
        userId,
        idempotencyKey: key,
        scheduleSlot: "2026-09-27T10:00Z",
      }),
    ).rejects.toThrow();

    const all = await testDb.select().from(runs).where(eq(runs.goalId, goalId));
    expect(all).toHaveLength(1);
  });

  it("rejects two steps claiming the same position in one run", async () => {
    const userId = await seedUser("step_index_owner");
    const goalId = randomUUID();
    const runId = randomUUID();

    await testDb.insert(goals).values({
      id: goalId,
      userId,
      title: "Steps",
      statement: "Publish twice",
      scheduleCron: "0 10 * * *",
    });
    await testDb.insert(runs).values({
      id: runId,
      goalId,
      userId,
      idempotencyKey: `goal:${goalId}:slot`,
      scheduleSlot: "2026-09-27T10:00Z",
    });

    const step = (index: number) => ({
      id: randomUUID(),
      runId,
      stepIndex: index,
      label: `Step ${index}`,
      capability: "publish_post",
      targetAccount: "x:hilbras",
      idempotencyKey: `${runId}:${index}:x:hilbras`,
    });

    await testDb.insert(runSteps).values([step(0), step(1)]);

    await expect(testDb.insert(runSteps).values(step(1))).rejects.toThrow();

    const steps = await testDb
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, runId));
    expect(steps).toHaveLength(2);
  });

  it("cascades runs, steps, and events when a goal is deleted", async () => {
    // Deleting a goal must not leave orphaned execution history behind that a
    // later run could collide with.
    const userId = await seedUser("cascade_owner");
    const goalId = randomUUID();
    const runId = randomUUID();
    const stepId = randomUUID();

    await testDb.insert(goals).values({
      id: goalId,
      userId,
      title: "Cascade",
      statement: "Publish",
      scheduleCron: "0 10 * * *",
    });
    await testDb.insert(runs).values({
      id: runId,
      goalId,
      userId,
      idempotencyKey: `goal:${goalId}:slot`,
      scheduleSlot: "2026-09-27T10:00Z",
    });
    await testDb.insert(runSteps).values({
      id: stepId,
      runId,
      stepIndex: 0,
      label: "Publish",
      capability: "publish_post",
      targetAccount: "x:hilbras",
      idempotencyKey: `${runId}:0:x:hilbras`,
    });
    await testDb.insert(runEvents).values({
      id: randomUUID(),
      runId,
      stepId,
      event: "run.started",
    });

    await testDb.delete(goals).where(eq(goals.id, goalId));

    expect(
      await testDb.select().from(runs).where(eq(runs.id, runId)),
    ).toHaveLength(0);
    expect(
      await testDb.select().from(runSteps).where(eq(runSteps.id, stepId)),
    ).toHaveLength(0);
    expect(
      await testDb.select().from(runEvents).where(eq(runEvents.runId, runId)),
    ).toHaveLength(0);
  });

  it("keeps a user's goals and runs isolated from another user's", async () => {
    const aliceId = await seedUser("tenant_alice");
    const bobId = await seedUser("tenant_bob");

    const aliceGoalId = randomUUID();
    await testDb.insert(goals).values({
      id: aliceGoalId,
      userId: aliceId,
      title: "Alice's goal",
      statement: "Publish",
      scheduleCron: "0 10 * * *",
    });
    await testDb.insert(runs).values({
      id: randomUUID(),
      goalId: aliceGoalId,
      userId: aliceId,
      idempotencyKey: `goal:${aliceGoalId}:slot`,
      scheduleSlot: "2026-09-27T10:00Z",
    });

    // Bob can attach a run to Alice's goal: the foreign key allows it, because
    // nothing in the schema ties runs.user_id to the goal's owner. Asserted
    // deliberately, so the gap stays visible — every read path must filter on
    // userId itself, and the runtime service is responsible for doing so.
    const bobRun = {
      id: randomUUID(),
      goalId: aliceGoalId,
      userId: bobId,
      idempotencyKey: `goal:${aliceGoalId}:slot-bob`,
      scheduleSlot: "2026-09-27T10:00Z",
    };
    await testDb.insert(runs).values(bobRun);

    const [crossed] = await testDb
      .select()
      .from(runs)
      .where(eq(runs.id, bobRun.id));
    expect(crossed.goalId).toBe(aliceGoalId);
    expect(crossed.userId).toBe(bobId);

    // The isolation therefore has to come from the query, not the schema.
    expect(
      await testDb.select().from(runs).where(eq(runs.userId, bobId)),
    ).toHaveLength(1);
    expect(
      await testDb.select().from(runs).where(eq(runs.userId, aliceId)),
    ).toHaveLength(1);
  });
});
