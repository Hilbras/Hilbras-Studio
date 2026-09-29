import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../../src/db/schema";

const { accounts, aiProviders, chatMessages, chatSessions, connections, memories, posts, rateLimits, storedCredentials, users } = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let dbModule: typeof import("../../src/db");
let lifecycleModule: typeof import("../../src/lib/account-lifecycle");
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
  // Bind the application pool to the disposable URL before the lifecycle
  // module (which imports `@/db`) is imported.
  dbModule = await importForContainer<typeof import("../../src/db")>("src/db");
  lifecycleModule = await importForContainer<typeof import("../../src/lib/account-lifecycle")>(
    "src/lib/account-lifecycle",
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

/**
 * Remediation Task 8: export and deletion behave like the privacy policy
 * describes, and can never reach past the calling user's own rows.
 */
describe("account export and deletion", () => {
  const makeUser = async (label: string) => {
    const id = randomUUID();
    await testDb.insert(users).values({
      id,
      name: `${label} Test`,
      email: `${label.toLowerCase()}-lifecycle@example.invalid`,
      username: `${label.toLowerCase()}_lifecycle`,
      passwordHash: `hashed-${label.toLowerCase()}-password`,
    });
    return id;
  };

  const seedTenant = async (userId: string, label: string) => {
    const postId = randomUUID();
    const connectionId = randomUUID();
    const sessionId = randomUUID();
    const providerId = randomUUID();
    const credentialId = randomUUID();

    await testDb.insert(posts).values({
      id: postId,
      userId,
      content: `${label} post`,
      status: "draft",
    });
    await testDb.insert(connections).values({
      id: connectionId,
      userId,
      platform: "x",
      accessTokenEnc: `enc:${label.toLowerCase()}-x-access-token`,
      refreshTokenEnc: `enc:${label.toLowerCase()}-x-refresh-token`,
    });
    await testDb.insert(accounts).values({
      id: randomUUID(),
      connectionId,
      userId,
      platform: "x",
      platformAccountId: `${label.toLowerCase()}-x-id`,
      accountKey: `x:${label.toLowerCase()}`,
    });
    await testDb.insert(aiProviders).values({
      id: providerId,
      userId,
      name: `${label} provider`,
      baseUrl: "https://provider.example",
      apiKeyEnc: `enc:${label.toLowerCase()}-api-key`,
      apiFormat: "openai",
      modelId: "model-1",
      isDefault: true,
    });
    await testDb.insert(storedCredentials).values({
      id: credentialId,
      userId,
      keyName: "openai_api_key",
      encryptedValue: `enc:${label.toLowerCase()}-stored-secret`,
      label: "OpenAI",
    });
    await testDb.insert(chatSessions).values({
      id: sessionId,
      userId,
      title: `${label} chat`,
    });
    await testDb.insert(chatMessages).values({
      id: randomUUID(),
      sessionId,
      role: "user",
      content: `${label} message`,
    });
    await testDb.insert(memories).values({
      id: randomUUID(),
      userId,
      content: `${label} remembers things`,
    });
    await testDb.insert(rateLimits).values([
      { key: `assistant:${userId}`, count: 1, resetAt: new Date() },
      { key: `ai:global:${userId}`, count: 1, resetAt: new Date() },
    ]);

    return { postId, connectionId, sessionId, providerId, credentialId };
  };

  it("exports exactly the caller's rows and never a secret value", async () => {
    const aliceId = await makeUser("Alice");
    const bobId = await makeUser("Bob");
    const aliceData = await seedTenant(aliceId, "Alice");
    await seedTenant(bobId, "Bob");

    const exported = await lifecycleModule.exportUserData(aliceId);
    const json = JSON.stringify(exported);

    // Alice's data is present.
    expect(exported.posts).toHaveLength(1);
    expect(json).toContain("Alice post");
    expect(json).toContain(aliceData.postId);

    // Bob's data is not.
    expect(json).not.toContain("Bob post");
    expect(json).not.toContain(bobId);

    // No secret material in any form — ciphertext is useless to the user and
    // plaintext values have no business in a downloadable file.
    expect(json).not.toContain("alice-x-access-token");
    expect(json).not.toContain("alice-api-key");
    expect(json).not.toContain("alice-stored-secret");
    expect(json).not.toContain("hashed-alice-password");
    // Presence flags record what existed.
    expect(json).toContain("apiKeyPresent");

    const byId = await testDb.select().from(users).where(eq(users.id, aliceId));
    expect(byId).toHaveLength(1);
  });

  it("deletes the tenant completely without touching another tenant", async () => {
    const aliceId = await makeUser("Carla");
    const bobId = await makeUser("Dave");
    const carla = await seedTenant(aliceId, "Carla");
    const dave = await seedTenant(bobId, "Dave");

    const result = await lifecycleModule.deleteAccount(aliceId);

    // The rate-limit rows carrying Carla's id went with her.
    expect(result.rateLimitRowsRemoved).toBe(2);

    const aliceRows = await testDb.select().from(users).where(eq(users.id, aliceId));
    const alicePosts = await testDb.select().from(posts).where(eq(posts.userId, aliceId));
    const aliceChats = await testDb
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.userId, aliceId));
    const aliceMemories = await testDb
      .select()
      .from(memories)
      .where(eq(memories.userId, aliceId));
    const aliceConnections = await testDb
      .select()
      .from(connections)
      .where(eq(connections.id, carla.connectionId));
    const aliceMessages = await testDb
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, carla.sessionId));
    expect(aliceRows).toHaveLength(0);
    expect(alicePosts).toHaveLength(0);
    expect(aliceChats).toHaveLength(0);
    expect(aliceMemories).toHaveLength(0);
    expect(aliceConnections).toHaveLength(0);
    expect(aliceMessages).toHaveLength(0);

    const aliceLimitRows = await testDb
      .select()
      .from(rateLimits)
      .where(eq(rateLimits.key, `assistant:${aliceId}`));
    expect(aliceLimitRows).toHaveLength(0);

    // Dave's tenant is byte-for-byte untouched.
    const bobRows = await testDb.select().from(users).where(eq(users.id, bobId));
    const bobPosts = await testDb.select().from(posts).where(eq(posts.userId, bobId));
    const bobChats = await testDb
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.userId, bobId));
    const bobLimitRows = await testDb
      .select()
      .from(rateLimits)
      .where(eq(rateLimits.key, `assistant:${bobId}`));
    const bobConnection = await testDb
      .select()
      .from(connections)
      .where(eq(connections.id, dave.connectionId));
    expect(bobRows).toHaveLength(1);
    expect(bobPosts).toHaveLength(1);
    expect(bobChats).toHaveLength(1);
    expect(bobLimitRows).toHaveLength(1);
    expect(bobConnection).toHaveLength(1);
  });
});
