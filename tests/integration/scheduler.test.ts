import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "../../src/db/schema";

const { posts, users } = schema;

/**
 * The runner must never talk to a real platform from tests. The mock is
 * hoisted before the module under test is dynamically imported (the import has
 * to wait for `DATABASE_URL` to point at the container anyway).
 */
const publishMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/publish", () => ({ publishToAllForUser: publishMock }));

let container: StartedPostgreSqlContainer;
let pool: Pool;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let dbModule: typeof import("../../src/db");
let scheduledModule: typeof import("../../src/lib/scheduled-posts");
let originalDatabaseUrl: string | undefined;

const importForContainer = async <T>(path: string): Promise<T> => {
  return import(resolve(process.cwd(), path));
};

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  testDb = drizzle(pool, { schema });
  await migrate(testDb, { migrationsFolder: resolve(process.cwd(), "drizzle") });

  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = container.getConnectionUri();

  dbModule = await importForContainer<typeof import("../../src/db")>("src/db");
  scheduledModule = await importForContainer<
    typeof import("../../src/lib/scheduled-posts")
  >("src/lib/scheduled-posts");
});

afterAll(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await pool?.end();
  await dbModule?.closeDb();
  await container?.stop();
});

beforeEach(() => {
  publishMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function createUser(prefix: string): Promise<string> {
  const id = randomUUID();
  await testDb.insert(users).values({
    id,
    name: `Scheduler ${prefix}`,
    email: `${prefix}-${id}@example.invalid`,
    username: `${prefix}_${id.slice(0, 8)}`,
    passwordHash: "not-a-real-hash",
  });
  return id;
}

interface PostOverrides {
  status?: string;
  scheduledAt?: Date | null;
  claimId?: string | null;
  claimExpiresAt?: Date | null;
  dispatchStartedAt?: Date | null;
  publishedAt?: Date | null;
  platforms?: string;
}

async function createPost(userId: string, overrides: PostOverrides = {}): Promise<string> {
  const id = randomUUID();
  const past = new Date(Date.now() - 60_000);
  await testDb.insert(posts).values({
    id,
    userId,
    content: "Scheduled content",
    platforms: overrides.platforms ?? "instagram,x",
    status: overrides.status ?? "scheduled",
    scheduledAt: overrides.scheduledAt === undefined ? past : overrides.scheduledAt,
    claimId: overrides.claimId ?? null,
    claimExpiresAt: overrides.claimExpiresAt ?? null,
    dispatchStartedAt: overrides.dispatchStartedAt ?? null,
    publishedAt: overrides.publishedAt ?? null,
  });
  return id;
}

async function getPost(postId: string) {
  const [row] = await testDb.select().from(posts).where(eq(posts.id, postId));
  return row;
}

describe("scheduled-post runner claims and leases", () => {
  it("publishes a due post exactly once across overlapping runs", async () => {
    const userId = await createUser("overlap");
    const postId = await createPost(userId);
    publishMock.mockResolvedValue([
      { platform: "instagram", success: true, postId: "ig-1" },
      { platform: "x", success: true, postId: "x-1" },
    ]);

    const [cronRun, manualRun] = await Promise.all([
      scheduledModule.publishDuePosts(),
      scheduledModule.publishDuePosts({ userId }),
    ]);

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(cronRun.processed + manualRun.processed).toBe(1);

    const row = await getPost(postId);
    expect(row?.status).toBe("published");
    expect(row?.claimId).toBeNull();
    expect(row?.claimExpiresAt).toBeNull();
    expect(row?.dispatchStartedAt).toBeNull();
    expect(JSON.parse(row!.results!)).toEqual([
      { platform: "instagram", success: true, postId: "ig-1" },
      { platform: "x", success: true, postId: "x-1" },
    ]);
  });

  it("keeps ownership of a claim whose lease is still valid", async () => {
    const userId = await createUser("lease");
    const postId = await createPost(userId, {
      status: "publishing",
      claimId: "other-run",
      claimExpiresAt: new Date(Date.now() + 4 * 60_000),
      dispatchStartedAt: new Date(Date.now() - 1000),
    });

    await scheduledModule.publishDuePosts({ userId });

    expect(publishMock).not.toHaveBeenCalled();
    const row = await getPost(postId);
    expect(row?.status).toBe("publishing");
    expect(row?.claimId).toBe("other-run");
  });

  it("re-queues an expired claim that never dispatched to a platform", async () => {
    const userId = await createUser("requeue");
    const postId = await createPost(userId, {
      status: "publishing",
      claimId: "dead-run",
      claimExpiresAt: new Date(Date.now() - 1000),
      dispatchStartedAt: null,
    });
    publishMock.mockResolvedValue([{ platform: "instagram", success: true }]);

    const summary = await scheduledModule.publishDuePosts({ userId });

    expect(summary.published).toBe(1);
    expect(publishMock).toHaveBeenCalledTimes(1);
    const row = await getPost(postId);
    expect(row?.status).toBe("published");
    expect(row?.claimId).toBeNull();
  });

  it("does not blindly retry an expired claim that already dispatched", async () => {
    const userId = await createUser("uncertain");
    const postId = await createPost(userId, {
      status: "publishing",
      claimId: "dead-run",
      claimExpiresAt: new Date(Date.now() - 1000),
      dispatchStartedAt: new Date(Date.now() - 5000),
    });

    const summary = await scheduledModule.publishDuePosts({ userId });

    expect(publishMock).not.toHaveBeenCalled();
    expect(summary.processed).toBe(0);
    const row = await getPost(postId);
    expect(row?.status).toBe("failed");
    expect(row?.claimId).toBeNull();
    const results = JSON.parse(row!.results!);
    expect(results).toEqual([
      {
        platform: "unknown",
        success: false,
        error: expect.stringContaining("outcome unknown"),
      },
    ]);
  });

  it("does not blindly retry a legacy publishing row with no lease columns", async () => {
    const userId = await createUser("legacy");
    const postId = await createPost(userId, {
      status: "publishing",
      claimId: null,
      claimExpiresAt: null,
      dispatchStartedAt: null,
      publishedAt: new Date(Date.now() - 10 * 60_000),
    });

    await scheduledModule.publishDuePosts({ userId });

    expect(publishMock).not.toHaveBeenCalled();
    const row = await getPost(postId);
    expect(row?.status).toBe("failed");
    expect(JSON.parse(row!.results!)[0].error).toContain("outcome unknown");
  });

  it("finalizes only while the run still owns the claim", async () => {
    const userId = await createUser("ownership");
    const postId = await createPost(userId);
    publishMock.mockImplementation(async () => {
      // Simulate the lease expiring and another actor taking the row over
      // while this run's provider call is in flight.
      await testDb
        .update(posts)
        .set({ claimId: "taken-over", status: "scheduled" })
        .where(eq(posts.id, postId));
      return [{ platform: "instagram", success: true }];
    });

    const summary = await scheduledModule.publishDuePosts({ userId });

    // The stale run still reports what it observed...
    expect(summary.published).toBe(1);
    // ...but it must not have overwritten the newer state on the row.
    const row = await getPost(postId);
    expect(row?.status).toBe("scheduled");
    expect(row?.claimId).toBe("taken-over");
  });
});

describe("scheduled-post runner time budgets", () => {
  it("stops the run at the deadline without claiming posts", async () => {
    const userId = await createUser("deadline");
    const postId = await createPost(userId);

    const summary = await scheduledModule.publishDuePosts({ userId, runDeadlineMs: 0 });

    expect(summary.processed).toBe(0);
    expect(publishMock).not.toHaveBeenCalled();
    const row = await getPost(postId);
    expect(row?.status).toBe("scheduled");
    expect(row?.claimId).toBeNull();
  });

  it("fails a hanging provider call as uncertain and never retries it", async () => {
    const userId = await createUser("hang");
    const postId = await createPost(userId);
    publishMock.mockReturnValue(new Promise<never>(() => undefined));

    const summary = await scheduledModule.publishDuePosts({
      userId,
      postTimeoutMs: 80,
      runDeadlineMs: 10_000,
    });

    expect(summary.failed).toBe(1);
    expect(publishMock).toHaveBeenCalledTimes(1);
    let row = await getPost(postId);
    expect(row?.status).toBe("failed");
    expect(JSON.parse(row!.results!)[0].error).toContain("outcome unknown");

    // A later run must not pick it up again automatically.
    const secondRun = await scheduledModule.publishDuePosts({ userId });
    expect(secondRun.processed).toBe(0);
    expect(publishMock).toHaveBeenCalledTimes(1);
    row = await getPost(postId);
    expect(row?.status).toBe("failed");
  });

  it("keeps partial platform results visible and accurate", async () => {
    const userId = await createUser("partial");
    const postId = await createPost(userId);
    publishMock.mockResolvedValue([
      { platform: "instagram", success: true, postId: "ig-1" },
      { platform: "x", success: false, error: "permission denied" },
    ]);

    const summary = await scheduledModule.publishDuePosts({ userId });

    expect(summary).toMatchObject({ processed: 1, published: 1, failed: 0 });
    const row = await getPost(postId);
    expect(row?.status).toBe("published");
    expect(JSON.parse(row!.results!)).toEqual([
      { platform: "instagram", success: true, postId: "ig-1" },
      { platform: "x", success: false, error: "permission denied" },
    ]);
  });

  it("marks a post failed when every platform refuses", async () => {
    const userId = await createUser("allfail");
    const postId = await createPost(userId);
    publishMock.mockResolvedValue([
      { platform: "instagram", success: false, error: "bad token" },
      { platform: "x", success: false, error: "rate limited" },
    ]);

    const summary = await scheduledModule.publishDuePosts({ userId });

    expect(summary).toMatchObject({ processed: 1, published: 0, failed: 1 });
    const row = await getPost(postId);
    expect(row?.status).toBe("failed");
    expect(row?.publishedAt).toBeNull();
    expect(JSON.parse(row!.results!)).toHaveLength(2);
  });
});
