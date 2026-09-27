/**
 * Accounts & Connections (ADR-006).
 *
 * The v0.1.0 model conflated a grant with an identity: one `social_accounts`
 * row held a token *and* a `platform_account_id`, with no unique constraint, and
 * both OAuth callbacks **deleted every row for (user, platform) before
 * inserting**. The practical consequence was stronger than "the newest
 * connection wins" — a second account on the same platform was not merely
 * unreachable, connecting it destroyed the first.
 *
 * This module is the replacement write path. It makes three guarantees the old
 * one could not:
 *
 * 1. **Connecting never destroys.** A reconnect updates the grant and upserts
 *    the accounts it reaches; it does not delete the user's other accounts.
 * 2. **An account is identified, not guessed.** `account_key`
 *    (`platform:handle`) is unique per user, so "which account is this?" is
 *    answerable without a `limit(1)`.
 * 3. **Disabling is intent, not health.** A disabled account is skipped by plan
 *    validation and says so, rather than disappearing from a run.
 *
 * `social_accounts` remains authoritative for the v0.1.0 publish path until
 * v0.5.0; nothing here writes to it.
 */

import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { accounts, connections, type Account } from "@/db/schema";

import { getConnector } from "@/lib/connectors/legacy";
import type { CapabilityName } from "@/lib/connectors/types";
import { capabilitiesForPlatform } from "@/lib/platforms";

/** The stable reference a goal and a plan use to name an account. */
export function accountKeyFor(
  platform: string,
  handleOrId: string | null | undefined,
): string {
  const slug =
    handleOrId?.trim() ||
    // No handle: fall back to the platform id rather than producing a bare
    // "x:" that would collide across every handle-less account.
    "id";
  return `${platform}:${slug}`;
}

export interface RegisterConnectionInput {
  userId: string;
  platform: string;
  accessTokenEnc: string | null;
  refreshTokenEnc?: string | null;
  tokenExpiresAt?: Date | null;
  /** Accounts the grant reaches. One today; several for Meta page tokens. */
  accounts: Array<{
    platformAccountId: string;
    handle?: string | null;
    displayName?: string | null;
  }>;
}

/**
 * Record a grant and the accounts it reaches.
 *
 * Idempotent per account: reconnecting the same identity updates it in place
 * rather than appending a duplicate — which the missing unique constraint on
 * `social_accounts` made impossible.
 */
export async function registerConnection(
  input: RegisterConnectionInput,
): Promise<{ connectionId: string; accountIds: string[] }> {
  const connectionId = randomUUID();

  await db.insert(connections).values({
    id: connectionId,
    userId: input.userId,
    platform: input.platform,
    accessTokenEnc: input.accessTokenEnc,
    refreshTokenEnc: input.refreshTokenEnc ?? null,
    tokenExpiresAt: input.tokenExpiresAt ?? null,
  });

  const accountIds: string[] = [];
  for (const account of input.accounts) {
    const key = accountKeyFor(
      input.platform,
      account.handle ?? account.platformAccountId,
    );

    // Conflict on (user, platform, identity) or on account_key: the account
    // already exists from an earlier grant, so move it onto this connection
    // rather than failing the whole connect.
    const inserted = await db
      .insert(accounts)
      .values({
        id: randomUUID(),
        connectionId,
        userId: input.userId,
        platform: input.platform,
        platformAccountId: account.platformAccountId,
        accountKey: key,
        handle: account.handle ?? null,
        displayName: account.displayName ?? account.handle ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: accounts.id });

    if (inserted.length) {
      accountIds.push(inserted[0].id);
      continue;
    }

    const [existing] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, input.userId),
          eq(accounts.platform, input.platform),
          eq(accounts.platformAccountId, account.platformAccountId),
        ),
      )
      .limit(1);

    if (!existing) {
      // The unique keys disagree with the identity lookup — only reachable if
      // account_key collides across different identities. Fail loudly rather
      // than silently dropping an account the user connected.
      throw new Error(
        `Account ${key} conflicted with a different identity and was not found`,
      );
    }

    // Repoint the existing account at the fresh grant, so its token comes from
    // the connection the user just authorised.
    await db
      .update(accounts)
      .set({ connectionId })
      .where(eq(accounts.id, existing.id));
    accountIds.push(existing.id);
  }

  return { connectionId, accountIds };
}

/** An account plus what the Runtime needs to decide whether it can act. */
export interface ResolvedAccount {
  id: string;
  accountKey: string;
  platform: string;
  handle: string | null;
  enabled: boolean;
  capabilities: readonly CapabilityName[];
  connectionId: string;
}

function parseCapabilities(
  raw: string | null,
): readonly CapabilityName[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CapabilityName[]) : null;
  } catch {
    // A malformed column must not make the account unresolvable — fall back to
    // the platform's own set rather than failing the whole lookup.
    return null;
  }
}

/**
 * What a specific account can do.
 *
 * Prefers the account's stored set, because a platform's capabilities are not
 * uniform across account types. Falls back to the registry, which is what a
 * backfilled account has until capabilities are resolved for it.
 */
export function capabilitiesForAccount(
  account: Pick<Account, "platform" | "capabilities">,
): readonly CapabilityName[] {
  const stored = parseCapabilities(account.capabilities);
  if (stored) return stored;

  const connector = getConnector(account.platform);
  if (connector) return connector.capabilities;

  return capabilitiesForPlatform(account.platform);
}


const toResolved = (row: Account): ResolvedAccount => ({
  id: row.id,
  accountKey: row.accountKey,
  platform: row.platform,
  handle: row.handle,
  enabled: row.enabled,
  capabilities: capabilitiesForAccount(row),
  connectionId: row.connectionId,
});

/**
 * Resolve one account by its `platform:handle` key, scoped to its owner.
 *
 * Scoped to `userId` on purpose: account keys are unique per user, not
 * globally, and the Runtime must never be able to resolve another tenant's
 * account by guessing a handle.
 */
export async function resolveAccount(
  userId: string,
  accountKey: string,
): Promise<ResolvedAccount | null> {
  const [row] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.accountKey, accountKey)))
    .limit(1);

  return row ? toResolved(row) : null;
}

/** Every account a user has, for the Accounts screen. */
export async function listAccounts(
  userId: string,
): Promise<ResolvedAccount[]> {
  const rows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .orderBy(accounts.platform, accounts.accountKey);

  return rows.map(toResolved);
}

/** Accounts a goal may target: connected, enabled, and able to act. */
export async function listSelectableAccounts(
  userId: string,
  capability: CapabilityName,
): Promise<ResolvedAccount[]> {
  const all = await listAccounts(userId);
  return all.filter((a) => a.enabled && a.capabilities.includes(capability));
}

/** Turn one account on or off. Disabling never removes it or its tokens. */
export async function setAccountEnabled(
  userId: string,
  accountId: string,
  enabled: boolean,
): Promise<boolean> {
  const rows = await db
    .update(accounts)
    .set({ enabled })
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
    .returning({ id: accounts.id });
  return rows.length > 0;
}

/** Remove one account, and its grant only if this was the grant's last account. */
export async function disconnectAccount(
  userId: string,
  accountId: string,
): Promise<boolean> {
  const removed = await db
    .delete(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
    .returning({ connectionId: accounts.connectionId });

  if (!removed.length) return false;

  // A Meta login covering three Pages keeps its token while one Page is
  // removed; only the last account takes the grant with it.
  const [remaining] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(accounts)
    .where(eq(accounts.connectionId, removed[0].connectionId));

  if ((remaining?.count ?? 0) === 0) {
    await db
      .delete(connections)
      .where(
        and(
          eq(connections.id, removed[0].connectionId),
          eq(connections.userId, userId),
        ),
      );
  }

  return true;
}

/** Disconnect every account on a platform — the v0.1.0 "remove connection". */
export async function disconnectPlatform(
  userId: string,
  platform: string,
): Promise<number> {
  const removed = await db
    .delete(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.platform, platform)))
    .returning({ id: accounts.id });

  if (!removed.length) return 0;

  await db
    .delete(connections)
    .where(
      and(eq(connections.userId, userId), eq(connections.platform, platform)),
    );

  return removed.length;
}

/** Accounts whose grant is expired or tokenless, for the UI to surface. */
export async function listAccountsNeedingAttention(
  userId: string,
): Promise<Array<{ accountKey: string; reason: "expired" | "no_token" }>> {
  const rows = await db
    .select({
      accountKey: accounts.accountKey,
      accessTokenEnc: connections.accessTokenEnc,
      tokenExpiresAt: connections.tokenExpiresAt,
    })
    .from(accounts)
    .innerJoin(connections, eq(accounts.connectionId, connections.id))
    .where(eq(accounts.userId, userId));

  const now = Date.now();
  return rows.flatMap((row): Array<{ accountKey: string; reason: "expired" | "no_token" }> => {
    if (!row.accessTokenEnc) {
      return [{ accountKey: row.accountKey, reason: "no_token" }];
    }
    if (row.tokenExpiresAt && row.tokenExpiresAt.getTime() <= now) {
      return [{ accountKey: row.accountKey, reason: "expired" }];
    }
    return [];
  });
}


/**
 * Platforms a user has at least one account on.
 *
 * The v0.1.0 read paths asked `SELECT platform FROM social_accounts` to answer
 * "what is this user connected to?". After ADR-006 that question is about
 * *accounts*, not grants, and a user may hold several accounts on one platform —
 * so this returns distinct platforms rather than assuming one connection each.
 */
export async function listConnectedPlatforms(
  userId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ platform: accounts.platform })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  return rows.map((r) => r.platform);
}

/** How many accounts a user has on a platform — the UI shows a count, not a toggle. */
export async function countAccountsOnPlatform(
  userId: string,
  platform: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.platform, platform)));
  return row?.count ?? 0;
}

/**
 * A grant with the accounts behind it, for token readers.
 *
 * `connection-health` and `token-maintenance` need the token, not the account
 * identity — so they read grants rather than accounts, and report per account
 * where a user can see it.
 */
export async function listGrants(userId: string) {
  return db
    .select({
      connectionId: connections.id,
      platform: connections.platform,
      accessTokenEnc: connections.accessTokenEnc,
      tokenExpiresAt: connections.tokenExpiresAt,
      connectedAt: connections.connectedAt,
      accountKey: accounts.accountKey,
      enabled: accounts.enabled,
    })
    .from(connections)
    .innerJoin(
      accounts,
      eq(accounts.connectionId, connections.id),
    )
    .where(eq(accounts.userId, userId))
    // Newest first: connection-health takes the first row per platform, and it
    // has always resolved "newest grant wins". Ascending here would silently
    // probe the oldest token instead.
    .orderBy(desc(connections.connectedAt));
}

/** Bulk lookup the planner uses to resolve a plan's targets. */
export async function resolveAccounts(
  userId: string,
  accountKeys: readonly string[],
): Promise<ResolvedAccount[]> {
  if (!accountKeys.length) return [];
  const rows = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        inArray(accounts.accountKey, [...accountKeys]),
      ),
    );
  return rows.map(toResolved);
}

