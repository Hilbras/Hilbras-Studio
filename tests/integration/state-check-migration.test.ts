import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../../src/db/schema";
import { GOAL_STATUSES } from "../../src/lib/goals/validation";
import { APPROVAL_STATES } from "../../src/lib/runtime/approvals";
import { EXECUTION_STATES } from "../../src/lib/runtime/state";

/**
 * v0.11.0 migration 0017: CHECK constraints on the four remaining state columns.
 *
 * These are the same three reasons `goal-migration.test.ts` exists, applied to a
 * different kind of migration, plus one of its own.
 *
 * **A constraint cannot be tested from a database that already has it.** If
 * `migrate()` runs to completion and a row is inserted afterwards, the insert
 * fails for the *application's* reasons and the CHECK is never exercised. The
 * test would pass with the constraint deleted. Rows have to exist *before* the
 * migration runs, so this file migrates to 0016, inserts, and only then applies
 * 0017.
 *
 * **The interesting direction is the refusal.** A CHECK that rejects good data
 * would be caught by any test that inserts a row afterwards. The failure this
 * guards against is the opposite: a CHECK that silently does nothing, so a
 * corrupt state is written and later read by code that cannot interpret it. So
 * the central test here is that a *bad* value is refused.
 *
 * **And the preflight is itself the artefact under test.** The preflight
 * queries were written to be run by hand against a real database before 0017 is
 * applied, and nothing executes them in the normal test run. A preflight with a
 * typo in a table or column is worse than no preflight, because it reports
 * "clean" and the migration then fails against production. The last test in
 * this file therefore runs the preflight file itself as written on disk, and
 * requires it to find a row that is actually there.
 */

const MIGRATIONS = resolve(process.cwd(), "drizzle");
const PREFLIGHT = resolve(MIGRATIONS, "0017_state_checks.preflight.sql");

let container: StartedPostgreSqlContainer;
let pool: Pool;

const url = () => container.getConnectionUri();

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: url() });

  // Migrate to 0016 — one short of 0017 — so rows can be inserted while the
  // columns are still unconstrained. Drizzle tracks what it has applied in
  // `__drizzle_migrations`, so the later full `migrate()` applies exactly 0017.
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

/**
 * Fixtures, built with Drizzle's insert rather than raw SQL.
 *
 * Every one of these tables has NOT NULL columns without a default — a goal
 * needs a title, a statement, a schedule — and hand-written `INSERT`s that
 * enumerate them break the next time a column is added. Going through the
 * schema means the fixture stays valid as the tables change, and it keeps these
 * tests about the constraints instead of about which columns happen to be
 * required today.
 */
const db = () => drizzle(pool);

async function makeUser(): Promise<string> {
  const id = randomUUID();
  await db().insert(schema.users).values({
    id,
    name: "Preflight User",
    email: `${id}@example.com`,
    username: `u_${id.slice(0, 8)}`,
    passwordHash: "hash",
  });
  return id;
}

async function makeGoal(userId: string): Promise<string> {
  const id = randomUUID();
  await db().insert(schema.goals).values({
    id,
    userId,
    title: "Preflight goal",
    statement: "Exists only so a run has a parent.",
    scheduleCron: "0 9 * * *",
  });
  return id;
}

async function makeRun(goalId: string, userId: string): Promise<string> {
  const id = randomUUID();
  await db()
    .insert(schema.runs)
    .values({ id, goalId, userId, idempotencyKey: `k_${id}`, scheduleSlot: "2026-09-30T09:00Z" });
  return id;
}

async function makeStep(runId: string, state?: string): Promise<string> {
  const id = randomUUID();
  await db().insert(schema.runSteps).values({
    id,
    runId,
    stepIndex: 0,
    label: "Publish to X",
    capability: "publish_post",
    idempotencyKey: `s_${id}`,
    ...(state ? { state } : {}),
  });
  return id;
}

/**
 * Require that inserting `state` is refused because of the CHECK constraint.
 *
 * Asserting on the constraint *name* does not work here: Drizzle wraps the
 * driver error in "Failed query: …" and the cause is only reachable via the
 * nested property, so the name never reaches `error.message`. Asserting on the
 * name therefore fails against a database that is correctly enforcing the
 * constraint — which is worse than no test, because it pushes you toward
 * weakening the assertion.
 *
 * `23514` is `check_violation` in PostgreSQL's SQLSTATE table. It is the right
 * thing to assert: it says "refused, and refused for this reason". A foreign-key
 * or not-null failure is a broken fixture and gives a different code, so a
 * fixture that goes stale fails loudly here instead of quietly testing nothing.
 */
async function expectRefused(
  insert: Promise<unknown>,
  constraint: string,
): Promise<void> {
  const error = await insert.then(
    () => null,
    (e: unknown) => e,
  );
  if (!error) {
    throw new Error(`the insert was ACCEPTED — ${constraint} is not enforcing anything`);
  }
  // Walk the cause chain: Drizzle nests the pg error under `cause`.
  const seen = new Set<unknown>();
  let code: string | undefined;
  let message = "";
  let cursor: unknown = error;
  while (cursor && typeof cursor === "object" && !seen.has(cursor)) {
    seen.add(cursor);
    const e = cursor as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === "string") code ??= e.code;
    if (typeof e.message === "string") message += " " + e.message;
    if (e.code === "23514") break;
    cursor = e.cause;
  }
  if (code !== "23514") {
    throw new Error(
      `expected check_violation (23514) from ${constraint}, got code=${code}: ${message}`,
    );
  }
  if (!message.includes(constraint)) {
    throw new Error(
      `the violation came from a different constraint than ${constraint}: ${message}`,
    );
  }
}

/** Does the named CHECK constraint exist? */
async function hasConstraint(constraint: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [
    constraint,
  ]);
  return rows.length === 1;
}

/**
 * Run `0017_state_checks.preflight.sql` as written on disk, one query at a time.
 *
 * The file is executed rather than reimplemented here. A test that duplicated
 * its queries would still be green if the file's were wrong, and the file is
 * what a human runs against production — so the artefact under test is the
 * artefact that ships.
 *
 * Split on `;` rather than sent whole: `pg` returns only the last result of a
 * multi-statement string, so sending the file as-is would report the final
 * query's rows and silently ignore the three before it. Strip comments first,
 * or a `;` inside a `--` block would split a statement in half.
 */
async function runPreflight(): Promise<Array<{ id: string; status?: string; state?: string }>> {
  const sql = readFileSync(PREFLIGHT, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  const found: Array<{ id: string; status?: string; state?: string }> = [];
  for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
    const { rows } = await pool.query(statement);
    found.push(...rows);
  }
  return found;
}

describe("0017 state constraints", () => {
  it("refuses a goal status outside the vocabulary", async () => {
    const uid = await makeUser();
    await expectRefused(
      db()
        .insert(schema.goals)
        .values({ id: randomUUID(), userId: uid, title: "t", statement: "s", scheduleCron: "0 9 * * *", status: "archived_pending" }),
      "goals_status_check",
    );
  });

  it("refuses a run state outside the vocabulary", async () => {
    const uid = await makeUser();
    const goalId = await makeGoal(uid);
    await expectRefused(
      db()
        .insert(schema.runs)
        .values({ id: randomUUID(), goalId, userId: uid, idempotencyKey: `k_${randomUUID()}`, scheduleSlot: "slot", state: "definitely_not_a_state" }),
      "runs_state_check",
    );
  });

  it("refuses a run_steps state outside the vocabulary", async () => {
    const uid = await makeUser();
    const goalId = await makeGoal(uid);
    const runId = await makeRun(goalId, uid);
    await expectRefused(
      db()
        .insert(schema.runSteps)
        .values({ id: randomUUID(), runId, stepIndex: 0, label: "l", capability: "publish_post", idempotencyKey: `s_${randomUUID()}`, state: "half_done" }),
      "run_steps_state_check",
    );
  });

  it("refuses an approval state outside the vocabulary", async () => {
    const uid = await makeUser();
    const goalId = await makeGoal(uid);
    const runId = await makeRun(goalId, uid);
    const stepId = await makeStep(runId);

    await expectRefused(
      db()
        .insert(schema.runStepApprovals)
        .values({
          id: randomUUID(),
          runId,
          stepId,
          userId: uid,
          tool: "publish_post",
          input: "{}",
          expiresAt: new Date(Date.now() + 3_600_000),
          state: "maybe",
        }),
      "run_step_approvals_state_check",
    );
  });

  it("still accepts every value in each vocabulary", async () => {
    // The other failure mode: a CHECK that is too strict and refuses valid
    // state. Every value in each vocabulary must survive.
    for (const status of GOAL_STATUSES) {
      const uid = await makeUser();
      await expect(
        db()
          .insert(schema.goals)
          .values({ id: randomUUID(), userId: uid, title: "t", statement: "s", scheduleCron: "0 9 * * *", status }),
      ).resolves.toBeDefined();
    }

    for (const state of EXECUTION_STATES) {
      const uid = await makeUser();
      const goalId = await makeGoal(uid);
      const runId = await makeRun(goalId, uid);
      await expect(
        db()
          .insert(schema.runs)
          .values({ id: randomUUID(), goalId, userId: uid, idempotencyKey: `k_${randomUUID()}`, scheduleSlot: "slot", state }),
      ).resolves.toBeDefined();
      await expect(makeStep(runId, state)).resolves.toBeDefined();
    }

    for (const state of APPROVAL_STATES) {
      const uid = await makeUser();
      const goalId = await makeGoal(uid);
      const runId = await makeRun(goalId, uid);
      const stepId = await makeStep(runId);
      await expect(
        db()
          .insert(schema.runStepApprovals)
          .values({
            id: randomUUID(),
            runId,
            stepId,
            userId: uid,
            tool: "publish_post",
            input: "{}",
            expiresAt: new Date(Date.now() + 3_600_000),
            state,
          }),
      ).resolves.toBeDefined();
    }
  });

  it("created all four constraints", async () => {
    for (const c of [
      "goals_status_check",
      "runs_state_check",
      "run_steps_state_check",
      "run_step_approvals_state_check",
    ]) {
      expect(await hasConstraint(c), `${c} was not created`).toBe(true);
    }
  });

  describe("the preflight a human runs before applying 0017", () => {
    it("is SELECT-only", () => {
      const sql = readFileSync(PREFLIGHT, "utf8");
      // A preflight that writes is a preflight you cannot run casually against
      // production to find out whether production is dirty.
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i);
    });

    it("reports a clean database as clean", async () => {
      expect(await runPreflight()).toEqual([]);
    });

    it("would catch a corrupt row that 0017 then refuses", async () => {
      // Drop the constraint so the bad value can be written the way a buggy
      // writer would write it — pre-existing data, not a new insert.
      await pool.query(`ALTER TABLE "goals" DROP CONSTRAINT "goals_status_check"`);
      const uid = await makeUser();
      const corruptId = randomUUID();
      await db()
        .insert(schema.goals)
        .values({ id: corruptId, userId: uid, title: "t", statement: "s", scheduleCron: "0 9 * * *", status: "archived_pending" });

      // The preflight must name it. This is the case the file exists for.
      const rows = await runPreflight();
      expect(rows.map((r) => r.id)).toContain(corruptId);

      // And re-applying 0017's constraint must FAIL, because the corrupt row is
      // still there. This is the whole reason the preflight exists: the
      // migration refuses to apply to a dirty database rather than locking it or
      // dropping the bad row.
      await expect(
        pool.query(
          `ALTER TABLE "goals" ADD CONSTRAINT "goals_status_check" CHECK ("goals"."status" in ('active', 'paused', 'archived'))`,
        ),
      ).rejects.toThrow(/goals_status_check/);

      // Correcting the row is what unblocks the migration.
      await db()
        .update(schema.goals)
        .set({ status: "archived" })
        .where(eq(schema.goals.id, corruptId));
      await expect(
        pool.query(
          `ALTER TABLE "goals" ADD CONSTRAINT "goals_status_check" CHECK ("goals"."status" in ('active', 'paused', 'archived'))`,
        ),
      ).resolves.toBeDefined();
    });
  });
});
