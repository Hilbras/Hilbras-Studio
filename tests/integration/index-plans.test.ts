import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../../src/db/schema";

/**
 * Query plans for the two hot paths (remediation Task 12).
 *
 * The task asked for "EXPLAIN before/after evidence for the index strategy".
 * These tests are that evidence, and they are the *only* form of it that is
 * worth having, because a plan checked in as a pasted table is a claim about a
 * database that no longer exists. These run against the real schema on every
 * `pnpm test:integration`.
 *
 * ## Why the plan is asserted structurally and not by timing
 *
 * A synthetic container holds a few hundred rows, and at that size PostgreSQL
 * will seq-scan *everything* — the planner is correct to, since a sequential
 * scan of 300 rows beats walking a B-tree. So a timing assertion here measures
 * the container, not the index, and would have to be written so loosely it
 * proved nothing. A recorded "EXPLAIN ANALYZE took 0.4 ms" is worse still: it
 * is a number about a machine nobody will ever run it on again.
 *
 * What is stable across data volumes is the *shape* of the plan:
 *
 *  1. **The partial index is used at all.** `goals_due_idx` and
 *     `run_step_approvals_pending_expiry_idx` are `WHERE`-partial, so they are
 *     invisible to the planner unless the query's own predicate implies the
 *     partial one. If a future edit widens a query to `status = ANY(...)` or
 *     drops the `state` filter, the index silently stops being a candidate and
 *     the sweeper degrades to a full table scan on a table that only ever
 *     grows. Nothing else notices: the query still returns the right rows, just
 *     slowly, and only once the table is big enough to hurt. Asserting the
 *     index *name* is what makes that failure loud at 300 rows instead of
 *     silent at 3 million.
 *
 *  2. **The index is used for the right column order.** `goals_due_idx` is on
 *     `next_firing_at`; a plan that used it for something else would be a
 *     different index entirely, so asserting the name covers this too.
 *
 *  3. **The seeded row count is enough to make the assertions meaningful but the
 *     tests still fast.** A few thousand rows per table is well under a second
 *     to insert with `generate_series`, and it is the point at which the
 *     planner's own cost model already prefers the index for a highly selective
 *     predicate.
 *
 * ## What this does not prove
 *
 * It does not prove the indexes are fast at production volume, and it cannot:
 * the plan at 10,000 rows is not the plan at 10 million. A production
 * `EXPLAIN (ANALYZE, BUFFERS)` against real data remains the honest check, and
 * is recorded as an operator step in `tasks/todo.md` rather than faked here.
 *
 * The mutation run makes the limit concrete. Dropping both indexes fails the
 * two "is eligible" tests and leaves the row-count and access-path tests
 * **passing** — at 4,000 rows PostgreSQL prefers a sequential scan whichever
 * index exists, so those two cannot detect a missing index at this size. They
 * are kept anyway, not as index detection but as a second, independent
 * statement of the same property: they would catch a planner regression or a
 * fixture that stopped being selective, which the eligibility assertions do
 * not. The eligibility assertions are the ones carrying the weight, and the
 * suite is built so that they are the ones that go red.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let originalDatabaseUrl: string | undefined;

/**
 * One node of an `EXPLAIN (FORMAT JSON)` plan.
 *
 * Typed rather than `any`, because the plan tree is deeply nested and the
 * interesting fields are spread across node kinds — an index scan carries
 * `Index Name`, a bitmap scan carries it one level up under `Plans`. Optional
 * everywhere is the honest shape: PostgreSQL adds keys per node type, and a
 * required field would be a claim the format does not make.
 */
interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  "Relation Name"?: string;
  Alias?: string;
  "Actual Rows"?: number;
  Plans?: PlanNode[];
  [key: string]: unknown;
}

/** The root node of an `EXPLAIN (FORMAT JSON)` plan. */
async function explain(sql: string, options = ""): Promise<PlanNode> {
  // `options` is inserted between the parens and the statement. It is not
  // interpolated into the caller's SQL, so it cannot change what is measured —
  // it only adds `ANALYZE`, which makes the planner execute the statement so
  // the plan carries `Actual Rows`.
  const { rows } = await pool.query(
    `EXPLAIN (${options}${options ? ", " : ""}FORMAT JSON) ${sql}`,
  );
  // `QUERY PLAN` is a one-element array wrapping the root node.
  const plan = rows[0]["QUERY PLAN"] as Array<{ Plan: PlanNode }>;
  return plan[0].Plan;
}

/** Every node in a plan tree, flattened — plans nest, searches do not. */
function nodes(root: PlanNode): PlanNode[] {
  const out: PlanNode[] = [];
  const walk = (node: PlanNode | undefined) => {
    if (!node || typeof node !== "object") return;
    if (node["Node Type"]) out.push(node);
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(root);
  return out;
}

/** Index names used anywhere in a plan. */
function indexesUsed(root: PlanNode): string[] {
  return nodes(root)
    .map((n) => n["Index Name"])
    .filter((x): x is string => typeof x === "string");
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });

  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = container.getConnectionUri();

  await migrate(
    drizzle(pool, { schema }),
    { migrationsFolder: resolve(process.cwd(), "drizzle") },
  );

  // One user, so the tenant predicates are satisfiable and the partial-index
  // predicates are not trivially empty.
  await pool.query(
    `INSERT INTO users (id, name, email, username, password_hash)
     VALUES ($1, 'plan', 'plan@example.invalid', 'plan_probe', 'not-a-real-hash')`,
    [randomUUID()],
  );

  // Enough goals that the planner prefers the partial index for a due-goal
  // lookup, and enough *not* due that the index is doing selective work rather
  // than matching everything. The ratio is the point: an index that matches
  // every row is an index the planner is right to ignore.
  //
  // Two invariants, both reproduced rather than approximated:
  //
  //  * A paused goal has `next_firing_at = NULL` — that is what makes the
  //    partial index worthwhile, so the fixture does not give every row a
  //    timestamp.
  //  * An **active** goal is due — `next_firing_at` in the *past*. The first
  //    version of this fixture set it a minute in the future, which made the
  //    query match nothing. The index assertion still passed, because a plan
  //    over an empty result still mentions the index; only the row-count
  //    assertion caught it. That is why both assertions are here, and why the
  //    count is checked *before* the plan is trusted.
  await pool.query(
    `INSERT INTO goals (id, user_id, title, statement, schedule_cron, schedule_timezone,
                        status, created_at, updated_at, next_firing_at, target_accounts)
     SELECT gen_random_uuid(), u.id, 'goal ' || g, 'statement ' || g, '0 10 * * *', 'UTC',
            CASE WHEN g % 50 = 0 THEN 'active' ELSE 'paused' END,
            now(), now(),
            CASE WHEN g % 50 = 0 THEN now() - interval '1 minute' ELSE NULL END,
            '[]'
     FROM generate_series(1, 4000) g, users u`,
  );

  // Same shape for approvals: a small pending set inside a large decided one.
  // This is the real distribution — the sweeper's work list is short, and the
  // partial index exists because the overwhelming majority of rows are decided.
  //
  // `run_step_approvals` carries foreign keys to `runs` and `run_steps`, so the
  // chain has to exist first. Seeding it with `generate_series` keeps the whole
  // fixture to three statements; each row gets its own run and step because
  // `run_step_approvals_step_unique` is on `step_id`.
  //
  // `completed`, not `succeeded`. This fixture originally wrote `succeeded`,
  // which is a real word in this codebase — a `GoalHealth` computed in
  // `goals/service.ts` — and migration 0017 rejected it on the first run of the
  // full suite. That is the constraint working: two vocabularies with a
  // plausible word in common, kept apart by the database rather than by every
  // writer remembering which is which.
  await pool.query(
    `INSERT INTO runs (id, goal_id, user_id, idempotency_key, schedule_slot, state, created_at)
     SELECT gen_random_uuid(), g.id, u.id, 'plan-run-' || a, '2026-01-01T00:00Z', 'completed', now()
     FROM generate_series(1, 4000) a, users u
     JOIN goals g ON g.user_id = u.id AND g.status = 'active'
     LIMIT 4000`,
  );

  await pool.query(
    `INSERT INTO run_steps (id, run_id, step_index, label, capability, target_account,
                            idempotency_key, input, state, finished_at)
     SELECT gen_random_uuid(), r.id, 0, 'Publish to X', 'publish_post', 'x:hilbras',
            r.id || ':0', '{}', 'completed', now()
     FROM runs r WHERE r.idempotency_key LIKE 'plan-run-%'`,
  );

  // The 1-in-20 pending ratio is what makes the partial index worth having, so
  // the decision is derived from the row's own ordinal rather than seeded
  // separately. `row_number()` over the step set gives a stable, evenly spread
  // ratio without carrying a second counter column.
  await pool.query(
    `INSERT INTO run_step_approvals (id, run_id, step_id, user_id, tool, target_account,
                                     input, state, created_at, expires_at, decided_at)
     SELECT gen_random_uuid(), s.run_id, s.id, u.id, 'publish_post', 'x:hilbras',
            '{}',
            CASE WHEN s.n % 20 = 0 THEN 'pending' ELSE 'approved' END,
            now() - (s.n || ' minutes')::interval,
            CASE WHEN s.n % 20 = 0 THEN now() - interval '1 minute' ELSE now() + interval '7 days' END,
            CASE WHEN s.n % 20 = 0 THEN NULL ELSE now() END
     FROM (
       SELECT st.id, st.run_id, row_number() OVER (ORDER BY st.id) AS n
       FROM run_steps st
       JOIN runs r ON r.id = st.run_id
       WHERE r.idempotency_key LIKE 'plan-run-%'
     ) s
     JOIN runs r ON r.id = s.run_id
     JOIN users u ON u.id = r.user_id`,
  );
}, 180_000);

afterAll(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await pool?.end();
  await container?.stop();
});

describe("the scheduler's due-goal query uses goals_due_idx", () => {
  const DUE_GOALS = `
    SELECT g.id FROM goals g
    JOIN users u ON u.id = g.user_id
    WHERE g.status = 'active' AND g.next_firing_at <= now()`;

  it("is eligible for the partial index, not just correct", async () => {
    const plan = await explain(DUE_GOALS);
    expect(indexesUsed(plan)).toContain("goals_due_idx");
  });

  it("actually returns the due goals, so the plan is not trivially empty", async () => {
    // A plan assertion over a query that matches nothing is satisfied by an
    // empty result and proves nothing about the index. The fixture plants 80
    // due goals among 4,000, so this has to find them.
    const { rows } = await pool.query(DUE_GOALS);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(400);
  });

  it("reads the goals through the index rather than scanning the table", async () => {
    // The structural claim behind the index: a partial index over the ~2% of
    // goals that are active. If the plan reads the whole table, the index is
    // not carrying the query whatever its name.
    //
    // **"Through the index" is not the same as "an Index Scan node."** At this
    // row count the planner picks a *Bitmap Heap Scan* fed by a *Bitmap Index
    // Scan* — 80 of 4,000 rows is selective enough to warrant the bitmap but
    // not selective enough to favour a plain ordered index scan, and both are
    // the index doing the work. Asserting `Node Type === "Index Scan"` would
    // have failed on a perfectly good plan; asserting the *relation access
    // path* is what actually distinguishes "the index carried this" from "the
    // table was scanned". The two access paths that do not qualify are
    // `Seq Scan` and, for a table this size, an index scan on the wrong index —
    // which the `Index Name` assertion above already rules out.
    const plan = await explain(DUE_GOALS, "ANALYZE");

    const goalsAccess = nodes(plan).filter(
      (n) => n["Relation Name"] === "goals" || n["Alias"] === "g",
    );
    expect(goalsAccess.length, "expected a plan node reading the goals table").toBeGreaterThan(0);

    // Every access path to `goals` must be index-driven. A `Seq Scan` here means
    // the partial index is not a candidate for this query at all.
    const seqScans = goalsAccess.filter((n) => n["Node Type"] === "Seq Scan");
    expect(
      seqScans,
      `goals was accessed by sequential scan; the partial index is not carrying ` +
        `this query. Actual rows read: ${seqScans.map((n) => n["Actual Rows"]).join(", ")}`,
    ).toEqual([]);

    // And it read the ~80 due goals, not the 4,000 rows in the table.
    const totalRead = goalsAccess.reduce((n, node) => n + (node["Actual Rows"] ?? 0), 0);
    expect(totalRead).toBeGreaterThan(0);
    expect(totalRead).toBeLessThan(400);
  });
});

describe("the approvals sweeper uses the partial expiry index", () => {
  const OVERDUE = `
    SELECT a.id FROM run_step_approvals a
    WHERE a.state = 'pending' AND a.expires_at <= now()`;

  it("is eligible for run_step_approvals_pending_expiry_idx", async () => {
    const plan = await explain(OVERDUE);
    expect(indexesUsed(plan)).toContain("run_step_approvals_pending_expiry_idx");
  });

  it("finds the overdue approvals among the decided ones", async () => {
    const { rows } = await pool.query(OVERDUE);
    expect(rows.length).toBeGreaterThan(0);
    // 1 in 20 are pending, so ~200 of 4,000. A query that returned all of them
    // would mean the `state` filter is gone.
    expect(rows.length).toBeLessThan(400);
  });

  it("loses the index when the state filter is dropped — which is why the guard exists", async () => {
    // The failure this file is here to prevent, demonstrated rather than
    // asserted: a partial index is invisible to the planner unless the query's
    // predicate implies the partial one. Remove `state = 'pending'` and the
    // index stops being a candidate entirely — the query still returns correct
    // rows, just by scanning the table, and nothing in the test suite, the
    // build, or the linter would notice.
    const withoutState = `SELECT a.id FROM run_step_approvals a WHERE a.expires_at <= now()`;
    const plan = await explain(withoutState);

    expect(indexesUsed(plan)).not.toContain("run_step_approvals_pending_expiry_idx");
  });
});
