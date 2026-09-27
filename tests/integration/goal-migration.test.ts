import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../../src/db/schema";

const { goals, users } = schema;

/**
 * v0.6.0 migration 0012: the `next_firing_at` backfill.
 *
 * This is a separate file from `goals.test.ts` for one reason, and it is the
 * reason this test is worth writing at all.
 *
 * **A backfill cannot be tested from a database that has already migrated.** If
 * `migrate()` runs to completion in `beforeAll` and rows are inserted
 * afterwards, every insert supplies `next_firing_at` itself and the `UPDATE` in
 * the migration is never exercised. The test passes with the UPDATE deleted —
 * which is precisely the bug it exists to catch. Rows have to exist *before* the
 * migration runs.
 *
 * So this file migrates to 0011, inserts, and only then applies 0012. Drizzle
 * tracks what it has applied in `__drizzle_migrations`, so the second `migrate()`
 * over the real folder applies exactly the one new file.
 *
 * The property under test: a goal that already existed and was active is
 * **due**, not silently unscheduled. A NULL firing time on an active goal is a
 * goal that looks configured, shows a schedule, and never runs — the failure
 * mode a backfill exists to prevent, and the reason the scheduler's query
 * (`next_firing_at <= now()`) would otherwise skip it forever.
 */

const MIGRATIONS = resolve(process.cwd(), "drizzle");
const BACKFILL = "0012_goal_next_firing";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let staging: string;

/**
 * A copy of the migrations folder with 0012 removed.
 *
 * Copying rather than pointing at a fixture keeps the first half of this test
 * honest: it runs the real 0000–0011 against a real Postgres, so a schema drift
 * in an earlier migration shows up here too.
 */
function stageWithoutBackfill(): string {
  const dir = mkdtempSync(join(tmpdir(), "hilbras-migrations-"));
  cpSync(MIGRATIONS, dir, { recursive: true });

  rmSync(join(dir, `${BACKFILL}.sql`), { force: true });

  // The journal is what the migrator reads, not the directory. A .sql file with
  // no journal entry is silently ignored — which is exactly the failure this
  // file has to avoid reproducing in reverse.
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter(
    (entry: { tag: string }) => entry.tag !== BACKFILL,
  );
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));

  return dir;
}

async function seedUser(name: string): Promise<string> {
  const id = randomUUID();
  await testDb.insert(users).values({
    id,
    name,
    email: `${name}@example.invalid`,
    username: name,
    passwordHash: "not-a-real-hash",
  });
  return id;
}

/**
 * A goal row exactly as a pre-0012 client would have written it.
 *
 * Raw SQL on purpose. Drizzle builds its INSERT from the *current* schema, which
 * already knows about `next_firing_at` — so a drizzle insert here would name a
 * column the staged database does not have. That failure is useful: it proves the
 * staging really did stop at 0011, and it is why this file cannot pretend the
 * ordinary test helpers are enough.
 */
async function insertPreMigrationGoal(opts: {
  userId: string;
  title: string;
  status: "active" | "paused";
}): Promise<void> {
  await pool.query(
    `INSERT INTO goals
       (id, user_id, title, statement, schedule_cron, schedule_timezone,
        target_accounts, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())`,
    [
      randomUUID(),
      opts.userId,
      opts.title,
      "Written before the column existed.",
      "0 9 * * *",
      "Europe/Berlin",
      JSON.stringify(["x:hilbras"]),
      opts.status,
    ],
  );
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  testDb = drizzle(pool, { schema });

  // 1. The schema as it stood before this release.
  staging = stageWithoutBackfill();
  await migrate(testDb, { migrationsFolder: staging });
});

afterAll(async () => {
  rmSync(staging, { recursive: true, force: true });
  await pool?.end();
  await container?.stop();
});

describe("migration 0012", () => {
  it("stops at 0011, so the column does not exist yet", async () => {
    // The precondition. If this fails, every assertion below is measuring
    // nothing — the rows would be inserted into a table that already has the
    // column, which is what the ordinary integration tests do.
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'goals' AND column_name = 'next_firing_at'`,
    );

    expect(columns.rows).toEqual([]);
  });

  it("makes an existing active goal due when 0012 runs", async () => {
    const userId = await seedUser("mig_active");

    await insertPreMigrationGoal({
      userId,
      title: "Active before the migration",
      status: "active",
    });

    // 2. Now apply the release.
    await migrate(testDb, { migrationsFolder: MIGRATIONS });

    const [row] = await testDb
      .select()
      .from(goals)
      .where(eq(goals.title, "Active before the migration"));

    expect(row.nextFiringAt).not.toBeNull();
    // Immediately due, not pushed a day out. A schedule that has already passed
    // *is* due, and nothing in the schema recorded whether it was ever served —
    // so deferring it would silently skip a posting the user asked for.
    expect(row.nextFiringAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("leaves a paused goal with no firing time", async () => {
    const userId = await seedUser("mig_paused");

    await insertPreMigrationGoal({
      userId,
      title: "Paused before the migration",
      status: "paused",
    });

    const [row] = await testDb
      .select()
      .from(goals)
      .where(eq(goals.title, "Paused before the migration"));

    // A goal on hold has no next firing. The partial index excludes these rows
    // anyway, so the two agree — and no future edit to the predicate can pick up
    // a goal the user deliberately stopped.
    expect(row.nextFiringAt).toBeNull();
  });

  it("builds a partial index that only covers active goals", async () => {
    const indexes = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'goals' AND indexname = 'goals_due_idx'`,
    );

    expect(indexes.rows).toHaveLength(1);
    // The predicate is part of the index, not a filter someone has to remember
    // to repeat — and `listDueGoals` repeats it anyway, because a partial index
    // does not imply the filter.
    expect(indexes.rows[0].indexdef).toContain("WHERE");
    expect(indexes.rows[0].indexdef).toContain("status");
    expect(indexes.rows[0].indexdef).toContain("active");
  });

  it("uses a timezone-aware column, so the instant does not depend on the session", async () => {
    const columns = await pool.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'goals' AND column_name = 'next_firing_at'`,
    );

    // Every other timestamp in this schema is a bare `timestamp`, which Postgres
    // reads and writes in the session's TimeZone. This one is compared against
    // `now()` and denotes the same moment whatever the connection is configured
    // to — the alternative is a bug that only appears once a connection pool
    // differs from the migration's.
    expect(columns.rows[0]?.data_type).toBe("timestamp with time zone");
  });
});
