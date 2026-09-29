import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../../src/db/schema";

/**
 * Migration 0016: every bare `timestamp` becomes `timestamptz`.
 *
 * This file exists because the migration **overrides a recorded deferral**, and a
 * decision that reverses a decision has to be argued for rather than assumed.
 * `tasks/todo.md` twice declined this work by name — "`posts.scheduled_at` is a
 * bare `timestamp` (second, undocumented contract) — migrating it to
 * `timestamptz` needs a deliberate data decision" — and 0016 does it for 33
 * columns across 19 tables with no note attached. This is the note, in executable
 * form: what the conversion claims, and the two ways it could be wrong.
 *
 * ## The claim
 *
 * A bare `timestamp` stores a wall-clock reading with no zone. Read it back
 * under a session set to `America/New_York` and `09:30` means a different instant
 * than it does under `Europe/Berlin`. That is not a display quirk; it is the
 * column type's contract, and it means the same row is a different moment
 * depending on who asks. `timestamptz` stores the instant itself and cannot
 * disagree with itself.
 *
 * ## Why the conversion is not automatically safe
 *
 * `USING "col" AT TIME ZONE 'UTC'` says the stored wall-clock was *UTC* and
 * reinterprets it as such — which preserves the instant exactly, and is the
 * right thing for a database that ran in UTC (Vercel Postgres, and the
 * `postgres:16-alpine` container these tests run in).
 *
 * The whole safety of 0016 rests on that precondition. A database whose server
 * ran in local time stored local wall-clock, and the same expression would
 * reinterpret every one of those rows as UTC — shifting them, silently, by the
 * offset. That is not detectable from the schema afterwards, which is why the
 * precondition is asserted below rather than left in a comment, and why the
 * migration note records it as a preflight the operator runs.
 *
 * ## What a test here can and cannot reach
 *
 * The conversion's meaning depends on what is already in the table, so the rows
 * have to be written **before** the migration runs — the same constraint that
 * `goal-migration.test.ts` documents for backfills. So this file stages the
 * journal at 0015, inserts rows as raw SQL through the pre-0016 schema, and only
 * then applies the real 0016 from the real folder.
 */

const MIGRATIONS = resolve(process.cwd(), "drizzle");
const CONVERSION = "0016_timestamps_to_timestamptz";
const CONVERSION_FILE = resolve(MIGRATIONS, `${CONVERSION}.sql`);

/**
 * A zone that is neither UTC nor the one used to write the rows.
 *
 * The point of the migration is that the answer stops depending on the session,
 * so the test has to actually move the session to show it.
 */
const FOREIGN_ZONE = "America/New_York";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let staging: string;

/**
 * The migrations folder truncated at 0015.
 *
 * The same staging technique as `goal-migration.test.ts`, for the same reason:
 * the journal is what the migrator reads, so it is the journal that has to be cut
 * — removing a `.sql` file alone would be silently ignored, and removing only the
 * file while leaving a later high-water mark behind would make the real 0016 look
 * already-applied and skip it.
 */
function stageBeforeConversion(): string {
  const dir = mkdtempSync(join(tmpdir(), "hilbras-tz-migrations-"));
  cpSync(MIGRATIONS, dir, { recursive: true });

  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const at = journal.entries.findIndex((entry: { tag: string }) => entry.tag === CONVERSION);
  if (at < 0) throw new Error(`no journal entry for ${CONVERSION}`);
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));

  for (const file of readdirSync(join(dir, "meta"))) {
    if (file === "_journal.json" || file === "0000_snapshot.json") continue;
    const index = Number(file.slice(0, 4));
    if (Number.isFinite(index) && index >= journal.entries.length) {
      rmSync(join(dir, "meta", file), { force: true });
    }
  }

  return dir;
}

/**
 * Read one column three ways, in the session's current zone.
 *
 * Three rather than one, because the type under test *changes* across the
 * migration and a single expression cannot mean the same thing on both sides.
 * `col AT TIME ZONE 'UTC'` yields a `timestamptz` when the column is bare and a
 * bare `timestamp` when it is not, so an assertion written once and used either
 * side of the migration silently measures something else. An earlier version of
 * this file made exactly that mistake and reported a false failure.
 *
 * - `stored` — the wall-clock reading as text. For a bare column this is the
 *   literal contents; for a `timestamptz` it is rendered in the session zone.
 * - `epoch` — `EXTRACT(EPOCH FROM col)`. For a **bare** timestamp PostgreSQL
 *   documents this as computing the epoch *as if the value were UTC*, so it is
 *   the same in every session and is the "what was meant" reading. For a
 *   `timestamptz` it is the instant itself.
 * - `sessionEpoch` — `EXTRACT(EPOCH FROM col::timestamptz)`, which is **the
 *   instant a caller in this session actually receives**, because casting a bare
 *   timestamp interprets it in the session zone. This is the field that moves
 *   before the migration and stops moving after it, so it is the one the
 *   ambiguity assertions compare. An earlier version compared `epoch` here and
 *   found no difference, because `epoch` cannot show this bug by construction.
 * - `utcWall` — the wall clock in UTC, for the readable check.
 */
async function readColumn(
  column: string,
  zone: string,
  table: string,
  key: string,
): Promise<{ stored: string; epoch: string; sessionEpoch: string; utcWall: string }> {
  // `set_config` rather than `SET TIME ZONE`: the latter is a utility statement
  // and takes no bind parameter, so the only way to write it is to interpolate
  // the zone into SQL. This keeps the value a parameter.
  await pool.query(`SELECT set_config('TimeZone', $1, false)`, [zone]);
  try {
    // `table` and `column` are literals from this file, and the row key is a bind
    // parameter, so nothing here is concatenated input.
    const { rows } = await pool.query(
      `SELECT ${column}::text AS stored,
              EXTRACT(EPOCH FROM ${column})::text AS epoch,
              EXTRACT(EPOCH FROM ${column}::timestamptz)::text AS session_epoch,
              to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS utc_wall
         FROM ${table} WHERE key = $1`,
      [key],
    );
    return {
      stored: rows[0].stored,
      epoch: rows[0].epoch,
      sessionEpoch: rows[0].session_epoch,
      utcWall: rows[0].utc_wall,
    };
  } finally {
    // Back to UTC so a failure cannot leak the zone into the next assertion.
    await pool.query(`SELECT set_config('TimeZone', 'UTC', false)`);
  }
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });

  staging = stageBeforeConversion();
  await migrate(drizzle(pool, { schema }), { migrationsFolder: staging });
});

afterAll(async () => {
  rmSync(staging, { recursive: true, force: true });
  await pool?.end();
  await container?.stop();
});

describe("migration 0016 — the SQL itself", () => {
  /**
   * Read the real file rather than restating it.
   *
   * A drift guard on the migration, so the "safe" property cannot be lost to a
   * later edit. Adding one bare `SET DATA TYPE timestamp with time zone` — the
   * obvious thing to write, and the thing that shifts data — fails here instead
   * of in production.
   */
  it("converts every column with AT TIME ZONE 'UTC', so no instant moves", () => {
    const sql = readFileSync(CONVERSION_FILE, "utf8");
    const conversions = sql
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.includes("SET DATA TYPE timestamp with time zone"));

    expect(conversions.length).toBeGreaterThan(0);

    const unsafe = conversions.filter((statement) => !statement.includes("AT TIME ZONE 'UTC'"));
    expect(
      unsafe,
      `these conversions reinterpret a stored wall-clock without saying which zone it was in:\n${unsafe.join("\n")}`,
    ).toEqual([]);
  });

  it("converts a column for every bare timestamp the schema still declares", () => {
    // The two sides have to agree, or the migration is either incomplete or has
    // rewritten a column the application no longer thinks is bare. Reading the
    // schema rather than a count means a new bare column fails here.
    const sql = readFileSync(CONVERSION_FILE, "utf8");
    const converted = new Set(
      [...sql.matchAll(/ALTER TABLE "(\w+)" ALTER COLUMN "(\w+)"/g)].map((m) => `${m[1]}.${m[2]}`),
    );

    const schemaSource = readFileSync(resolve(process.cwd(), "src/db/schema.ts"), "utf8");
    // `timestamp("col"` with no `withTimezone` in the same declaration. The
    // declaration is small, so a window of a few hundred characters is enough to
    // reach the options without crossing into the next column.
    const bare = [
      ...schemaSource.matchAll(/(\w+):\s*timestamp\("(\w+)"[^)]*\)/g),
    ]
      .filter((m) => !m[0].includes("withTimezone"))
      .map((m) => `${m[1]}.${m[2]}`);

    expect(bare, `the schema still declares bare timestamps: ${bare.join(", ")}`).toEqual([]);
    expect(converted.size).toBeGreaterThanOrEqual(30);
  });
});

describe("migration 0016 — what it does to a row that already exists", () => {
  /**
   * `rate_limits.reset_at` as the probe.
   *
   * A real column the migration converts, chosen because it stands alone: no
   * foreign key, so a row can be written through the pre-0016 schema with one
   * insert. The earlier version of this file used a self-made `tz_probe` table,
   * which measured nothing — 0016 names the tables it converts, and a table it
   * had never heard of stayed a bare `timestamp`, so every "after" assertion was
   * really an "before" one.
   */
  const PROBE = { table: "rate_limits", column: "reset_at" };
  const PROBE_KEY = "probe:timestamptz";

  /** Read the probe row, in the session's current zone. */
  const readProbe = (zone: string) =>
    readColumn(`${PROBE.table}.${PROBE.column}`, zone, PROBE.table, PROBE_KEY);

  /**
   * Columns 0016 is expected to convert. Every one of these was created bare by
   * an earlier migration.
   *
   * `goals.next_firing_at` is deliberately absent: 0012 added it as
   * `timestamptz` from the start, so 0016 has nothing to do to it. It is
   * asserted separately, because "the migration did not touch what was already
   * correct" is as much a part of a conversion being right as the rest of it.
   */
  const CONVERTED = [
    [PROBE.table, PROBE.column],
    ["posts", "scheduled_at"],
    ["posts", "dispatch_started_at"],
    ["accounts", "created_at"],
    ["runs", "started_at"],
    ["run_steps", "started_at"],
  ] as const;

  /** Already `timestamptz` before this release. */
  const ALREADY_ZONED = [["goals", "next_firing_at"]] as const;

  /** The `data_type` of one column, for the type assertions on either side. */
  async function dataType(table: string, column: string): Promise<string> {
    const { rows } = await pool.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2`,
      [table, column],
    );
    return rows[0]?.data_type ?? "(missing)";
  }

  it("starts from a schema where the columns are still bare timestamps", async () => {
    // The precondition, and the reason the row below is written with raw SQL. If
    // this fails, 0016 was applied during staging and the whole file is measuring
    // a conversion that already happened.
    for (const [table, column] of CONVERTED) {
      expect(
        await dataType(table, column),
        `${table}.${column} is not bare before 0016, so this file is measuring a conversion that already ran`,
      ).toBe("timestamp without time zone");
    }
    for (const [table, column] of ALREADY_ZONED) {
      expect(await dataType(table, column), `${table}.${column} was already zoned`).toBe(
        "timestamp with time zone",
      );
    }
  });

  it("reads one bare timestamp as two different instants depending on the session", async () => {
    // The bug 0016 exists to fix, asserted in the state where it is still true.
    // Without this the passing assertions after the migration are unfalsifiable:
    // they would pass just as well on a database that had never been ambiguous.
    //
    // A wall-clock reading, which is all a bare `timestamp` ever held. 09:30 on a
    // spring-forward day, because a DST edge is exactly where a zone assumption
    // does damage and it costs nothing to be standing there.
    await pool.query(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES ($1, 0, '2026-03-08 09:30:00')`,
      [PROBE_KEY],
    );

    const utc = await readProbe("UTC");
    const foreign = await readProbe(FOREIGN_ZONE);

    // The stored reading is the same either way — that is all a bare timestamp
    // is, a wall clock with nothing attached to it.
    expect(utc.stored).toBe("2026-03-08 09:30:00");
    expect(foreign.stored).toBe(utc.stored);
    expect(utc.utcWall).toBe("2026-03-08T09:30:00");

    // But the instant a caller receives is a function of who is asking. Same row,
    // four hours apart, decided entirely by the session. This is the whole
    // problem, and it is why `AT TIME ZONE 'UTC'` in 0016 is load-bearing.
    expect(foreign.sessionEpoch).not.toBe(utc.sessionEpoch);
    // Four hours — the New York offset on that date — so the failure is a
    // specific measured shift rather than any difference at all. New York is
    // *behind* UTC, so reading the same wall clock as New York time names a
    // moment four hours later than reading it as UTC.
    expect(Number(foreign.sessionEpoch) - Number(utc.sessionEpoch)).toBe(4 * 60 * 60);
    // And the "as if UTC" reading is the same everywhere, which is the only
    // reason the conversion can recover the intended instant at all: it is
    // choosing the UTC interpretation deliberately rather than by accident.
    expect(utc.sessionEpoch).toBe(utc.epoch);
  });

  it("leaves a null column null, rather than inventing an instant", async () => {
    // `posts.scheduled_at` is nullable and means "not scheduled". The conversion
    // is a `USING` expression applied to every row, and `NULL` has to survive it:
    // a conversion that filled in a default would schedule posts that were never
    // scheduled, which is the same class of silent damage as a shifted instant.
    const userId = "tz-probe-user";
    await pool.query(
      `INSERT INTO users (id, name, email, username, password_hash, created_at)
       VALUES ($1, 'Probe', 'probe@example.invalid', 'probe', 'not-a-real-hash', now())`,
      [userId],
    );
    await pool.query(
      `INSERT INTO posts (id, user_id, content, status, scheduled_at, created_at)
       VALUES ($1, $2, 'never scheduled', 'draft', NULL, now())`,
      ["tz-probe-post", userId],
    );

    const { rows } = await pool.query(
      `SELECT count(*)::int AS total,
              count(scheduled_at)::int AS scheduled
         FROM posts WHERE id = 'tz-probe-post'`,
    );
    expect(rows[0].total).toBe(1);
    expect(rows[0].scheduled).toBe(0);
  });

  it("preserves the instant exactly, and makes it session-independent", async () => {
    const before = await readProbe("UTC");

    // The real 0016, applied to the real folder. Drizzle applies only what is
    // pending, so this is exactly the conversion and nothing else.
    await migrate(drizzle(pool, { schema }), { migrationsFolder: MIGRATIONS });

    for (const [table, column] of CONVERTED) {
      expect(
        await dataType(table, column),
        `${table}.${column} was not converted by 0016`,
      ).toBe("timestamp with time zone");
    }
    // Untouched, because there was nothing to do. Re-converting it would take an
    // `ACCESS EXCLUSIVE` lock and rewrite the table for no gain.
    for (const [table, column] of ALREADY_ZONED) {
      expect(await dataType(table, column), `${table}.${column} changed type`).toBe(
        "timestamp with time zone",
      );
    }

    // Still null, after the conversion that touched every row of the table.
    const { rows: nulls } = await pool.query(
      `SELECT count(scheduled_at)::int AS scheduled FROM posts WHERE id = 'tz-probe-post'`,
    );
    expect(nulls[0].scheduled).toBe(0);

    const after = await readProbe("UTC");
    const afterForeign = await readProbe(FOREIGN_ZONE);

    // The instant did not move. The pre-migration "as if UTC" reading is what
    // `AT TIME ZONE 'UTC'` chose to preserve, so it is the thing to compare
    // against. This is the assertion that fails on a conversion *missing*
    // `AT TIME ZONE 'UTC'`: the wall clock would have been reinterpreted in the
    // session zone and every existing row would have shifted by that offset.
    expect(after.epoch).toBe(before.epoch);
    expect(after.epoch).toBe(before.sessionEpoch);
    // And the instant no longer depends on the reader, which is what the column
    // type bought. The same query in another session now returns the same moment.
    expect(afterForeign.sessionEpoch).toBe(after.sessionEpoch);
    // The wall clock is still readable, and now means UTC by definition rather
    // than by whatever the server happened to be set to.
    expect(after.utcWall).toBe("2026-03-08T09:30:00");
    // A `timestamptz` renders in the reader's zone, so the *displayed* clock
    // legitimately differs per session now. Before the migration it also
    // differed, but the underlying instant was ambiguous as well; now only the
    // presentation follows the reader, and the moment does not.
    expect(afterForeign.stored).not.toBe(after.stored);
    expect(afterForeign.stored).toContain("-04");
  });
});
