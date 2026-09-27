import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "../../src/db/schema";

const { users } = schema;

/**
 * Phase 3 (ADR-005): the publish receipt, which is what makes a retry safe.
 *
 * The run-level guard only protects *within* one run, and a retry is a new run
 * with a new id — so before this table existed, a retried step would publish a
 * second time with nothing to stop it. These tests assert the two properties
 * that close that hole: a known key never dispatches again, and a concurrent
 * duplicate cannot produce two receipts.
 */
let container: StartedPostgreSqlContainer;
let pool: Pool;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let dbModule: typeof import("../../src/db");
let receipts: typeof import("../../src/lib/accounts/receipts");
let legacy: typeof import("../../src/lib/connectors/legacy");
let publishModule: typeof import("../../src/lib/publish");
let originalDatabaseUrl: string | undefined;
let originalEncryptionKey: string | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  testDb = drizzle(pool, { schema });
  await migrate(testDb, { migrationsFolder: resolve(process.cwd(), "drizzle") });

  originalDatabaseUrl = process.env.DATABASE_URL;
  originalEncryptionKey = process.env.ENCRYPTION_KEY;
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = "integration-test-encryption-key";
  dbModule = await import(resolve(process.cwd(), "src/db"));
  receipts = await import(resolve(process.cwd(), "src/lib/accounts/receipts"));
  publishModule = await import(resolve(process.cwd(), "src/lib/publish"));
  legacy = await import(resolve(process.cwd(), "src/lib/connectors/legacy"));
});

afterAll(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalEncryptionKey;
  await pool?.end();
  await dbModule?.closeDb();
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

const xConnector = () => legacy.getConnector("x")!;

describe("publish receipts", () => {
  it("records a dispatch and reads it back", async () => {
    const userId = await seedUser("receipt_write");
    const key = `${randomUUID()}:0:x:hilbras`;

    expect(await receipts.findReceipt(userId, key)).toBeNull();
    expect(
      await receipts.recordReceipt({
        userId,
        idempotencyKey: key,
        accountKey: "x:hilbras",
        platform: "x",
        platformPostId: "post-1",
        permalink: "https://x.com/i/status/1",
      }),
    ).toBe(true);

    const found = await receipts.findReceipt(userId, key);
    expect(found?.platformPostId).toBe("post-1");
    expect(found?.permalink).toBe("https://x.com/i/status/1");
  });

  it("refuses to record the same key twice, so only one dispatch wins", async () => {
    const userId = await seedUser("receipt_race");
    const key = `${randomUUID()}:0:x:hilbras`;
    const record = (postId: string) =>
      receipts.recordReceipt({
        userId,
        idempotencyKey: key,
        accountKey: "x:hilbras",
        platform: "x",
        platformPostId: postId,
      });

    const results = await Promise.all([record("first"), record("second")]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("scopes a receipt to its owner", async () => {
    const alice = await seedUser("receipt_alice");
    const bob = await seedUser("receipt_bob");
    const key = `${randomUUID()}:0:x:hilbras`;

    await receipts.recordReceipt({
      userId: alice,
      idempotencyKey: key,
      accountKey: "x:hilbras",
      platform: "x",
      platformPostId: "alice-post",
    });

    // The same key text under a different owner must not resolve to Alice's
    // receipt, or a cross-tenant read would suppress a legitimate publish.
    expect(await receipts.findReceipt(bob, key)).toBeNull();
    expect((await receipts.findReceipt(alice, key))?.platformPostId).toBe(
      "alice-post",
    );
  });

  it("does not dispatch again when the key already has a receipt", async () => {
    // The property that matters: a retried step must not publish twice.
    const userId = await seedUser("receipt_replay");
    const key = `${randomUUID()}:0:x:hilbras`;

    const dispatch = vi.fn(async () => ({
      platform: "x",
      success: true,
      postId: "post-1",
    }));
    vi.spyOn(publishModule, "publishForUser").mockImplementation(
      dispatch as never,
    );

    await receipts.recordReceipt({
      userId,
      idempotencyKey: key,
      accountKey: "x:hilbras",
      platform: "x",
      platformPostId: "already-there",
      permalink: "https://x.com/i/status/0",
    });

    const outcome = await xConnector().publishPost(
      { userId, accountId: "x:hilbras" },
      { text: "hello", idempotencyKey: key },
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
    // The reported post is the real one, not a bare "already done".
    expect(outcome.ok && outcome.platformPostId).toBe("already-there");
  });

  it("records a receipt after a first successful dispatch", async () => {
    const userId = await seedUser("receipt_first");
    const key = `${randomUUID()}:0:x:hilbras`;

    const dispatch = vi.fn(async () => ({
      platform: "x",
      success: true,
      postId: "post-9",
    }));
    vi.spyOn(publishModule, "publishForUser").mockImplementation(
      dispatch as never,
    );

    const first = await xConnector().publishPost(
      { userId, accountId: "x:hilbras" },
      { text: "hello", idempotencyKey: key },
    );
    expect(first.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);

    // The retry now finds the receipt and does not dispatch again.
    const second = await xConnector().publishPost(
      { userId, accountId: "x:hilbras" },
      { text: "hello", idempotencyKey: key },
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(second.ok && second.platformPostId).toBe("post-9");
  });

  it("records no receipt for a failed dispatch", async () => {
    const userId = await seedUser("receipt_failed");
    const key = `${randomUUID()}:0:x:hilbras`;

    vi.spyOn(publishModule, "publishForUser").mockImplementation(
      (async () => ({
        platform: "x",
        success: false,
        error: "X not connected",
      })) as never,
    );

    const outcome = await xConnector().publishPost(
      { userId, accountId: "x:hilbras" },
      { text: "hello", idempotencyKey: key },
    );

    expect(outcome.ok).toBe(false);
    // A failed attempt must leave no receipt, or a later legitimate retry would
    // be suppressed and the post silently never published.
    expect(await receipts.findReceipt(userId, key)).toBeNull();
  });
});

