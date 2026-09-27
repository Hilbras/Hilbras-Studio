import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../../src/db/schema";

const { connections, users } = schema;

/**
 * Phase 2 (ADR-006): the guarantees the v0.1.0 model could not make.
 *
 * The decisive one is that connecting a *second* account on a platform no
 * longer destroys the first. Both OAuth callbacks used to delete every row for
 * (user, platform) before inserting, so this was not merely "hard to reach" — it
 * was impossible.
 */
let container: StartedPostgreSqlContainer;
let pool: Pool;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let store: typeof import("../../src/lib/accounts/store");
let dbModule: typeof import("../../src/db");
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
  store = await import(resolve(process.cwd(), "src/lib/accounts/store"));
});

afterAll(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalEncryptionKey;
  // The application pool has to be closed before the container is stopped,
  // or its idle sockets surface as uncaught "terminating connection" errors.
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

const connect = (userId: string, platform: string, handle: string) =>
  store.registerConnection({
    userId,
    platform,
    accessTokenEnc: "encrypted-token",
    accounts: [{ platformAccountId: `${platform}-id-${handle}`, handle }],
  });

const keysOf = async (userId: string) =>
  (await store.listAccounts(userId)).map((a) => a.accountKey).sort();

describe("accounts and connections", () => {
  it("keeps several accounts on one platform", async () => {
    const userId = await seedUser("multi_account");
    await connect(userId, "x", "hilbras");
    await connect(userId, "x", "hilbrasai");
    await connect(userId, "x", "personal");

    expect(await keysOf(userId)).toEqual([
      "x:hilbras",
      "x:hilbrasai",
      "x:personal",
    ]);
  });

  it("updates an account in place on reconnect rather than duplicating it", async () => {
    // social_accounts had no unique constraint, so reconnects appended rows and
    // the publish path could pick a stale one.
    const userId = await seedUser("reconnect");
    const first = await connect(userId, "instagram", "hilbras");
    const second = await connect(userId, "instagram", "hilbras");

    const all = await store.listAccounts(userId);
    expect(all).toHaveLength(1);
    // The account now hangs off the newest grant, so its token is the one just
    // authorised.
    expect(all[0].connectionId).toBe(second.connectionId);
    expect(all[0].id).toBe(first.accountIds[0]);
  });

  it("scopes account keys to their owner", async () => {
    const alice = await seedUser("owner_alice");
    const bob = await seedUser("owner_bob");
    await connect(alice, "x", "hilbras");
    await connect(bob, "x", "hilbras");

    const resolved = await store.resolveAccount(alice, "x:hilbras");
    expect(resolved).not.toBeNull();
    expect(resolved?.id).not.toBe(
      (await store.resolveAccount(bob, "x:hilbras"))?.id,
    );
  });

  it("disables one account without affecting the others on that platform", async () => {
    const userId = await seedUser("disable");
    await connect(userId, "x", "noisy");
    await connect(userId, "x", "quiet");

    const target = (await store.listAccounts(userId)).find(
      (a) => a.accountKey === "x:noisy",
    );
    expect(await store.setAccountEnabled(userId, target!.id, false)).toBe(true);

    expect(await keysOf(userId)).toEqual(["x:noisy", "x:quiet"]);
    const selectable = await store.listSelectableAccounts(
      userId,
      "publish_post",
    );
    expect(selectable.map((a) => a.accountKey)).toEqual(["x:quiet"]);
  });

  it("excludes connect-only platforms from selectable accounts", async () => {
    const userId = await seedUser("connect_only");
    await connect(userId, "x", "hilbras");
    await connect(userId, "linkedin", "hilbras");

    const selectable = await store.listSelectableAccounts(
      userId,
      "publish_post",
    );
    expect(selectable.map((a) => a.accountKey)).toEqual(["x:hilbras"]);

    // Still listed and resolvable — just not selectable for publishing.
    const linkedin = await store.resolveAccount(userId, "linkedin:hilbras");
    expect(linkedin).not.toBeNull();
    expect(linkedin?.capabilities).toEqual([]);
  });



  it("keeps a grant alive while another account still uses it", async () => {
    const userId = await seedUser("shared_grant");
    const grant = await store.registerConnection({
      userId,
      platform: "facebook",
      accessTokenEnc: "encrypted-token",
      accounts: [
        { platformAccountId: "page-a", handle: "pagea" },
        { platformAccountId: "page-b", handle: "pageb" },
      ],
    });

    const [first] = (await store.listAccounts(userId)).sort((a, b) =>
      a.accountKey.localeCompare(b.accountKey),
    );
    await store.disconnectAccount(userId, first.id);

    // One account gone; the grant must survive for the other.
    expect(
      await testDb
        .select()
        .from(connections)
        .where(eq(connections.id, grant.connectionId)),
    ).toHaveLength(1);

    const last = (await store.listAccounts(userId))[0];
    await store.disconnectAccount(userId, last.id);

    // Last account removed: now the grant goes too.
    expect(
      await testDb
        .select()
        .from(connections)
        .where(eq(connections.id, grant.connectionId)),
    ).toHaveLength(0);
  });

  it("cascades accounts when their grant is deleted", async () => {
    const userId = await seedUser("cascade_grant");
    const grant = await connect(userId, "x", "hilbras");

    await testDb
      .delete(connections)
      .where(eq(connections.id, grant.connectionId));

    expect(await store.listAccounts(userId)).toHaveLength(0);
  });

  it("surfaces accounts whose grant expired or has no token", async () => {
    const userId = await seedUser("attention");
    await store.registerConnection({
      userId,
      platform: "x",
      accessTokenEnc: "encrypted-token",
      tokenExpiresAt: new Date(Date.now() - 60_000),
      accounts: [{ platformAccountId: "x-stale", handle: "stale" }],
    });
    await store.registerConnection({
      userId,
      platform: "instagram",
      accessTokenEnc: null,
      accounts: [{ platformAccountId: "ig-none", handle: "notoken" }],
    });

    const attention = await store.listAccountsNeedingAttention(userId);
    const byKey = Object.fromEntries(
      attention.map((a) => [a.accountKey, a.reason]),
    );
    expect(byKey["x:stale"]).toBe("expired");
    expect(byKey["instagram:notoken"]).toBe("no_token");
  });

  it("refuses to enable or disconnect another user's account", async () => {
    const alice = await seedUser("boundary_alice");
    const bob = await seedUser("boundary_bob");
    await connect(alice, "x", "hilbras");

    const aliceAccount = (await store.listAccounts(alice))[0];
    expect(await store.setAccountEnabled(bob, aliceAccount.id, false)).toBe(
      false,
    );
    expect(await store.disconnectAccount(bob, aliceAccount.id)).toBe(false);
  });
});
