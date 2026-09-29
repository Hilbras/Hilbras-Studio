import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "../../src/db/schema";

const {
  accounts,
  chatMessages,
  chatSessions,
  connections,
  memories,
  postTargets,
  posts,
  users,
} = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let dbModule: typeof import("../../src/db");
let aiBudgetModule: typeof import("../../src/lib/ai-budget");
let originalDatabaseUrl: string | undefined;
let originalEncryptionKey: string | undefined;
let originalComposerLimit: string | undefined;
let originalGlobalLimit: string | undefined;

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
  originalComposerLimit = process.env.AI_COMPOSER_RATE_LIMIT;
  originalGlobalLimit = process.env.AI_GLOBAL_RATE_LIMIT;
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = "integration-test-encryption-key";
  // Force the application pool to bind the disposable URL before dependent
  // modules import `@/db`; it is closed explicitly in afterAll.
  dbModule = await importForContainer<typeof import("../../src/db")>("src/db");
  aiBudgetModule = await importForContainer<typeof import("../../src/lib/ai-budget")>(
    "src/lib/ai-budget",
  );
});

afterAll(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalEncryptionKey;
  if (originalComposerLimit === undefined) delete process.env.AI_COMPOSER_RATE_LIMIT;
  else process.env.AI_COMPOSER_RATE_LIMIT = originalComposerLimit;
  if (originalGlobalLimit === undefined) delete process.env.AI_GLOBAL_RATE_LIMIT;
  else process.env.AI_GLOBAL_RATE_LIMIT = originalGlobalLimit;
  await pool?.end();
  await dbModule?.closeDb();
  await container?.stop();
});

afterEach(() => {
  if (originalComposerLimit === undefined) delete process.env.AI_COMPOSER_RATE_LIMIT;
  else process.env.AI_COMPOSER_RATE_LIMIT = originalComposerLimit;
  if (originalGlobalLimit === undefined) delete process.env.AI_GLOBAL_RATE_LIMIT;
  else process.env.AI_GLOBAL_RATE_LIMIT = originalGlobalLimit;
  vi.restoreAllMocks();
});

describe("PostgreSQL migrations and tenant boundaries", () => {
  it("applies the migration chain and keeps user-owned rows isolated", async () => {
    const aliceId = randomUUID();
    const bobId = randomUUID();
    const alicePostId = randomUUID();
    const bobPostId = randomUUID();

    await testDb.insert(users).values([
      {
        id: aliceId,
        name: "Alice Test",
        email: "alice-test@example.invalid",
        username: "alice_test",
        passwordHash: "not-a-real-hash",
      },
      {
        id: bobId,
        name: "Bob Test",
        email: "bob-test@example.invalid",
        username: "bob_test",
        passwordHash: "not-a-real-hash",
      },
    ]);

    await testDb.insert(posts).values([
      {
        id: alicePostId,
        userId: aliceId,
        content: "Alice post",
        status: "draft",
      },
      {
        id: bobPostId,
        userId: bobId,
        content: "Bob post",
        status: "draft",
      },
    ]);

    // Targets live in their own table (ADR-006) — see 0011.
    await testDb.insert(postTargets).values([
      { postId: alicePostId, platform: "instagram", accountKey: null },
      { postId: bobPostId, platform: "x", accountKey: null },
    ]);

    const alicePosts = await testDb
      .select()
      .from(posts)
      .where(eq(posts.userId, aliceId));
    const bobPosts = await testDb
      .select()
      .from(posts)
      .where(eq(posts.userId, bobId));

    expect(alicePosts.map((post) => post.id)).toEqual([alicePostId]);
    expect(bobPosts.map((post) => post.id)).toEqual([bobPostId]);
    expect(alicePosts[0]?.content).not.toBe(bobPosts[0]?.content);
  });

  it("enforces the post status check and the one-default-provider invariant", async () => {
    // Drizzle wraps driver errors: the constraint name lives on the pg error
    // in `cause`, not on the wrapper's message.
    const expectViolation = async (statement: Promise<unknown>, pattern: RegExp) => {
      let error: unknown;
      try {
        await statement;
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      const messages: string[] = [];
      let current: unknown = error;
      while (current instanceof Error) {
        messages.push(current.message);
        current = (current as { cause?: unknown }).cause;
      }
      expect(messages.join(" ")).toMatch(pattern);
    };

    const userId = randomUUID();
    const postId = randomUUID();

    await testDb.insert(users).values({
      id: userId,
      name: "Constraint Test",
      email: "constraint-test@example.invalid",
      username: "constraint_test",
      passwordHash: "not-a-real-hash",
    });
    await testDb.insert(posts).values({
      id: postId,
      userId,
      content: "Status check",
      status: "draft",
    });

    // Only the five modeled post states are writable (migration 0014).
    await expectViolation(
      testDb.update(posts).set({ status: "queued" }).where(eq(posts.id, postId)),
      /posts_status_check/,
    );

    await testDb
      .update(posts)
      .set({ status: "published" })
      .where(eq(posts.id, postId));
    const [row] = await testDb.select().from(posts).where(eq(posts.id, postId));
    expect(row?.status).toBe("published");

    // The partial unique index permits several non-default providers per user…
    const first = randomUUID();
    const second = randomUUID();
    await testDb.insert(schema.aiProviders).values([
      {
        id: first,
        userId,
        name: "A",
        baseUrl: "https://a.example",
        apiKeyEnc: "enc-a",
        apiFormat: "openai",
        modelId: "model-a",
        isDefault: true,
      },
      {
        id: second,
        userId,
        name: "B",
        baseUrl: "https://b.example",
        apiKeyEnc: "enc-b",
        apiFormat: "openai",
        modelId: "model-b",
        isDefault: false,
      },
    ]);

    // …but never two defaults at once…
    await expectViolation(
      testDb.insert(schema.aiProviders).values({
        id: randomUUID(),
        userId,
        name: "C",
        baseUrl: "https://c.example",
        apiKeyEnc: "enc-c",
        apiFormat: "openai",
        modelId: "model-c",
        isDefault: true,
      }),
      /ai_providers_user_default_unique_idx/,
    );

    // …and the unset-then-set handover the selection action uses stays legal.
    await testDb.transaction(async (tx) => {
      await tx
        .update(schema.aiProviders)
        .set({ isDefault: false })
        .where(eq(schema.aiProviders.userId, userId));
      await tx
        .update(schema.aiProviders)
        .set({ isDefault: true })
        .where(eq(schema.aiProviders.id, second));
    });
    const providers = await testDb
      .select()
      .from(schema.aiProviders)
      .where(eq(schema.aiProviders.userId, userId));
    expect(providers.find((p) => p.id === second)?.isDefault).toBe(true);
    expect(providers.filter((p) => p.isDefault)).toHaveLength(1);
  });

  it("cascades user-owned chat and memory rows when a user is deleted", async () => {
    const userId = randomUUID();
    const sessionId = randomUUID();

    await testDb.insert(users).values({
      id: userId,
      name: "Cascade Test",
      email: "cascade-test@example.invalid",
      username: "cascade_test",
      passwordHash: "not-a-real-hash",
    });
    await testDb.insert(chatSessions).values({
      id: sessionId,
      userId,
      title: "Cascade test chat",
    });
    await testDb.insert(chatMessages).values({
      id: randomUUID(),
      sessionId,
      role: "user",
      content: "This row should cascade",
    });
    await testDb.insert(memories).values({
      id: randomUUID(),
      userId,
      content: "This memory should cascade",
    });
    // A grant and an account, so the cascade is asserted on the model that now
    // owns platform state (ADR-006) rather than the dropped `social_accounts`.
    const connectionId = randomUUID();
    await testDb.insert(connections).values({
      id: connectionId,
      userId,
      platform: "x",
    });
    await testDb.insert(accounts).values({
      id: randomUUID(),
      connectionId,
      userId,
      platform: "x",
      platformAccountId: "cascade-account",
      accountKey: "x:cascade",
    });

    await testDb.delete(users).where(eq(users.id, userId));

    const [remainingSession] = await testDb
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)));
    const remainingMessages = await testDb
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId));
    const remainingMemories = await testDb
      .select()
      .from(memories)
      .where(eq(memories.userId, userId));
    const remainingAccounts = await testDb
      .select()
      .from(accounts)
      .where(eq(accounts.userId, userId));
    const remainingConnections = await testDb
      .select()
      .from(connections)
      .where(eq(connections.userId, userId));

    expect(remainingSession).toBeUndefined();
    expect(remainingMessages).toHaveLength(0);
    expect(remainingMemories).toHaveLength(0);
    expect(remainingAccounts).toHaveLength(0);
    expect(remainingConnections).toHaveLength(0);
  });

  it("keeps a stored platform secret when only the client ID is edited", async () => {
    const userId = randomUUID();
    await testDb.insert(users).values({
      id: userId,
      name: "Credential Test",
      email: `credentials-${userId}@example.invalid`,
      username: `credentials_${userId.slice(0, 8)}`,
      passwordHash: "not-a-real-hash",
    });

    const { savePlatformCredentialsForUser } = await importForContainer<
      typeof import("../../src/lib/platform-credential-store")
    >("src/lib/platform-credential-store");
    const first = await savePlatformCredentialsForUser(
      userId,
      "x",
      "old-client-id",
      "original-secret",
    );
    expect(first).toEqual({ success: true });

    const { getUserCredentialValue } =
      await importForContainer<typeof import("../../src/lib/credential-store")>(
        "src/lib/credential-store",
      );
    const initialStatus = await getUserCredentialValue(
      userId,
      "x_client_id",
    );
    expect(initialStatus).toBe("old-client-id");
    expect(
      await getUserCredentialValue(
        userId,
        "x_client_secret",
      ),
    ).toBe("original-secret");

    const otherUser = randomUUID();
    await testDb.insert(users).values({
      id: otherUser,
      name: "Other Credential Test",
      email: `other-credentials-${otherUser}@example.invalid`,
      username: `other_credentials_${otherUser.slice(0, 8)}`,
      passwordHash: "not-a-real-hash",
    });
    await savePlatformCredentialsForUser(
      otherUser,
      "x",
      "other-client-id",
      "other-secret",
    );
    expect(await getUserCredentialValue(otherUser, "x_client_secret")).toBe(
      "other-secret",
    );
    expect(await getUserCredentialValue(userId, "x_client_secret")).toBe(
      "original-secret",
    );

    const replaced = await savePlatformCredentialsForUser(
      userId,
      "x",
      "replaced-client-id",
      "replacement-secret",
    );
    expect(replaced).toEqual({ success: true });
    expect(await getUserCredentialValue(userId, "x_client_id")).toBe(
      "replaced-client-id",
    );
    expect(await getUserCredentialValue(userId, "x_client_secret")).toBe(
      "replacement-secret",
    );

    const edited = await savePlatformCredentialsForUser(
      userId,
      "x",
      "new-client-id",
      "",
    );
    expect(edited).toEqual({ success: true });

    const storedSecret = await getUserCredentialValue(
      userId,
      "x_client_secret",
    );
    expect(storedSecret).toBe("replacement-secret");
    expect(await getUserCredentialValue(userId, "x_client_id")).toBe(
      "new-client-id",
    );
  });

  it("enforces shared AI budgets per user and deployment", async () => {
    process.env.AI_COMPOSER_RATE_LIMIT = "1";
    process.env.AI_GLOBAL_RATE_LIMIT = "2";

    const firstUser = randomUUID();
    const secondUser = randomUUID();
    const thirdUser = randomUUID();
    const first = await aiBudgetModule.consumeAiBudget(firstUser, "composer");
    const second = await aiBudgetModule.consumeAiBudget(secondUser, "composer");
    const blocked = await aiBudgetModule.consumeAiBudget(firstUser, "composer");
    const globalBlocked = await aiBudgetModule.consumeAiBudget(thirdUser, "composer");

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(blocked).toEqual({
      allowed: false,
      retryAfterSec: expect.any(Number),
      remaining: 0,
    });
    expect(globalBlocked).toEqual({
      allowed: false,
      retryAfterSec: expect.any(Number),
      remaining: 0,
    });
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(globalBlocked.retryAfterSec).toBeGreaterThan(0);
  });
});
