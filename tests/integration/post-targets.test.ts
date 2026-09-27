import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "../../src/db/schema";

const { postTargets, posts, users } = schema;

/**
 * v0.5.0 (ADR-006, §6 resolution 6): `post_targets` becomes the only record of
 * where a post goes, and `posts.platforms` is dropped.
 *
 * Two properties are load-bearing and neither was true before this migration:
 *
 *  1. A post and its targets are written together or not at all. Written
 *     separately, a failure between the two leaves a post that looks fine,
 *     schedules normally, and then cannot publish.
 *  2. One row per (post, platform, account). The reads report one platform per
 *     row, so a duplicate makes a single-platform post read as going to three
 *     platforms — and the Composer and Scheduler both render that count.
 *
 * The second is enforced twice on purpose: `setPostTargets` deletes before it
 * inserts, and the table carries a `UNIQUE NULLS NOT DISTINCT` constraint. The
 * delete-then-insert is what makes a legitimate re-write correct; the constraint
 * is what stops a concurrent writer. Testing only the service would leave the
 * database-level guarantee unverified.
 */

const publishMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/publish", () => ({ publishToAllForUser: publishMock }));

let container: StartedPostgreSqlContainer;
let pool: Pool;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let dbModule: typeof import("../../src/db");
let postService: typeof import("../../src/lib/posts/service");
let targets: typeof import("../../src/lib/posts/targets");
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
  postService = await importForContainer<typeof import("../../src/lib/posts/service")>(
    "src/lib/posts/service",
  );
  targets = await importForContainer<typeof import("../../src/lib/posts/targets")>(
    "src/lib/posts/targets",
  );
});

afterAll(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await pool?.end();
  await dbModule?.closeDb();
  await container?.stop();
});

async function seedUser(prefix: string): Promise<string> {
  const id = randomUUID();
  await testDb.insert(users).values({
    id,
    name: prefix,
    email: `${prefix}@example.invalid`,
    username: prefix,
    passwordHash: "not-a-real-hash",
  });
  return id;
}

async function rowsFor(postId: string): Promise<string[]> {
  const rows = await testDb
    .select({ platform: postTargets.platform })
    .from(postTargets)
    .where(eq(postTargets.postId, postId))
    .orderBy(postTargets.platform);
  return rows.map((r) => r.platform);
}

describe("post targets", () => {
  it("writes the post and its targets together", async () => {
    const userId = await seedUser("targets_write");

    const postId = await postService.createPost({
      userId,
      content: "Hello",
      platforms: ["x", "instagram"],
    });

    expect(await rowsFor(postId)).toEqual(["instagram", "x"]);
  });

  it("replaces the previous set instead of appending to it", async () => {
    const userId = await seedUser("targets_replace");
    const postId = await postService.createPost({
      userId,
      content: "Hello",
      platforms: ["x", "instagram"],
    });

    // Re-writing the same input must be indistinguishable from writing it once.
    await testDb.transaction((tx) => targets.setPostTargets(tx, postId, ["x", "instagram"]));

    expect(await rowsFor(postId)).toEqual(["instagram", "x"]);
  });

  it("narrows a post's targets when they are re-set", async () => {
    const userId = await seedUser("targets_narrow");
    const postId = await postService.createPost({
      userId,
      content: "Hello",
      platforms: ["x", "instagram", "facebook"],
    });

    await testDb.transaction((tx) => targets.setPostTargets(tx, postId, ["x"]));

    expect(await rowsFor(postId)).toEqual(["x"]);
  });

  it("de-duplicates a platform list that repeats itself", async () => {
    const userId = await seedUser("targets_dupe_input");
    const postId = await postService.createPost({
      userId,
      content: "Hello",
      // The Composer's form can submit a platform twice.
      platforms: ["x", "x", " instagram ", "instagram"],
    });

    expect(await rowsFor(postId)).toEqual(["instagram", "x"]);
  });

  it("rejects a duplicate (post, platform) row at the database level", async () => {
    const userId = await seedUser("targets_constraint");
    const postId = await postService.createPost({
      userId,
      content: "Hello",
      platforms: ["x"],
    });

    // `account_key` is NULL here, and Postgres treats NULLs as distinct in a
    // unique index by default. Without NULLS NOT DISTINCT this insert would
    // succeed and the read would report the post as going to two platforms.
    const error = await testDb
      .insert(postTargets)
      .values({ postId, platform: "x", accountKey: null })
      .then(
        () => null,
        (rejection: unknown) => rejection,
      );

    expect(error).not.toBeNull();

    // Asserted on the Postgres error rather than a message: Drizzle wraps
    // driver errors, and the wrapper's text is not a stable thing to match.
    const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
    expect(cause?.code).toBe("23505"); // unique_violation
    expect(cause?.constraint).toBe("post_targets_unique");
  });

  it("still allows one platform reached through two different accounts", async () => {
    const userId = await seedUser("targets_two_accounts");
    const postId = await postService.createPost({
      userId,
      content: "Hello",
      // Deliberately not "x" — a platform-level row would add a NULL
      // `account_key` and obscure what this test is about.
      platforms: ["instagram"],
    });

    // Per-account targeting is why the constraint covers `account_key` rather
    // than being on (post_id, platform) alone.
    await testDb.insert(postTargets).values([
      { postId, platform: "x", accountKey: "x:hilbras" },
      { postId, platform: "x", accountKey: "x:personal" },
    ]);

    const rows = await testDb
      .select({ accountKey: postTargets.accountKey })
      .from(postTargets)
      .where(and(eq(postTargets.postId, postId), eq(postTargets.platform, "x")));

    expect(rows.map((r) => r.accountKey).sort()).toEqual(["x:hilbras", "x:personal"]);
  });

  it("keeps each post's targets separate in a bulk read", async () => {
    const userId = await seedUser("targets_bulk");
    const first = await postService.createPost({
      userId,
      content: "First",
      platforms: ["x"],
    });
    const second = await postService.createPost({
      userId,
      content: "Second",
      platforms: ["instagram", "facebook"],
    });

    const read = await targets.getPostTargets([first, second]);

    expect(read.get(first)).toEqual(["x"]);
    expect(read.get(second)).toEqual(["facebook", "instagram"]);
  });

  it("omits a post with no targets rather than returning an empty list", async () => {
    const userId = await seedUser("targets_absent");
    const postId = await postService.createPost({
      userId,
      content: "Hello",
      platforms: ["x"],
    });

    await testDb.delete(postTargets).where(eq(postTargets.postId, postId));

    const read = await targets.getPostTargets([postId]);
    expect(read.has(postId)).toBe(false);
  });

  it("removes a post's targets when the post is deleted", async () => {
    const userId = await seedUser("targets_cascade");
    const postId = await postService.createPost({
      userId,
      content: "Hello",
      platforms: ["x", "instagram"],
    });

    await testDb.delete(posts).where(eq(posts.id, postId));

    expect(await rowsFor(postId)).toEqual([]);
  });

  it("marks a post failed, rather than silently skipping it, when it has no targets", async () => {
    const userId = await seedUser("targets_scheduler");
    const scheduledModule =
      await importForContainer<typeof import("../../src/lib/scheduled-posts")>(
        "src/lib/scheduled-posts",
      );

    const postId = randomUUID();
    await testDb.insert(posts).values({
      id: postId,
      userId,
      content: "Orphan",
      status: "scheduled",
      scheduledAt: new Date(Date.now() - 60_000),
    });

    publishMock.mockReset();
    const summary = await scheduledModule.publishDuePosts({ userId });

    expect(summary.processed).toBe(1);
    expect(summary.published).toBe(0);
    expect(summary.failed).toBe(1);
    // Crucially: no platform call is attempted for a post with nowhere to go.
    expect(publishMock).not.toHaveBeenCalled();
  });
});
