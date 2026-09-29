import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../../src/db/schema";

const { inboxReadState, users } = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let dbModule: typeof import("../../src/db");
let readStateModule: typeof import("../../src/lib/inbox/read-state");
let originalDatabaseUrl: string | undefined;
let originalEncryptionKey: string | undefined;

const importForContainer = async <T>(path: string): Promise<T> => {
  return import(resolve(process.cwd(), path));
};

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  testDb = drizzle(pool, { schema });
  await migrate(testDb, { migrationsFolder: resolve(process.cwd(), "drizzle") });

  originalDatabaseUrl = process.env.DATABASE_URL;
  originalEncryptionKey = process.env.ENCRYPTION_KEY;
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = "integration-test-encryption-key";
  dbModule = await importForContainer<typeof import("../../src/db")>("src/db");
  readStateModule = await importForContainer<typeof import("../../src/lib/inbox/read-state")>(
    "src/lib/inbox/read-state",
  );
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

describe("inbox read state", () => {
  const makeUser = async (label: string) => {
    const id = randomUUID();
    await testDb.insert(users).values({
      id,
      name: `${label} Test`,
      email: `${label.toLowerCase()}-readstate@example.invalid`,
      username: `${label.toLowerCase()}_readstate`,
      passwordHash: "not-a-real-hash",
    });
    return id;
  };

  it("marks messages read, scoped to the user and platform", async () => {
    const aliceId = await makeUser("Eve");
    const bobId = await makeUser("Frank");
    const messageId = randomUUID().replace(/-/g, "").slice(0, 32);

    await readStateModule.markMessageRead(aliceId, "x", messageId);

    const readKeys = await readStateModule.readMessageKeys("alice-x", ["x"]);
    expect(readKeys.size).toBe(0);

    // Only Alice's marker is hers.
    const aliceRead = await readStateModule.readMessageKeys(aliceId, [
      `x:${messageId}`,
      `x:other-message`,
      `instagram:${messageId}`,
    ]);
    expect(aliceRead).toEqual(new Set([`x:${messageId}`]));

    const bobRead = await readStateModule.readMessageKeys(bobId, [`x:${messageId}`]);
    expect(bobRead.size).toBe(0);

    // Marking again is idempotent, not a duplicate row.
    await readStateModule.markMessageRead(aliceId, "x", messageId);
    const rows = await testDb
      .select()
      .from(inboxReadState)
      .where(eq(inboxReadState.userId, aliceId));
    expect(rows).toHaveLength(1);
  });

  it("prunes markers older than the retention window", async () => {
    const userId = await makeUser("Greta");

    // A marker written 31 days ago, planted directly.
    const staleId = randomUUID();
    await testDb.insert(inboxReadState).values({
      id: staleId,
      userId,
      platform: "instagram",
      messageId: "stale-message",
      readAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });

    await readStateModule.markMessageRead(userId, "x", "fresh-message");

    const rows = await testDb
      .select()
      .from(inboxReadState)
      .where(eq(inboxReadState.userId, userId));
    expect(rows.map((r) => r.messageId)).toEqual(["fresh-message"]);
  });
});
