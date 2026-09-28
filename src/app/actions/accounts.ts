"use server";

/**
 * Server actions for connected accounts.
 *
 * ## The id is a row id, never an account key
 *
 * Both functions take `accounts.id` and let the store scope by the session's
 * own `userId`. `setAccountEnabled` and `disconnectAccount` already carry
 * `eq(accounts.userId, userId)` in their `WHERE`, so an id belonging to someone
 * else matches no row and nothing happens.
 *
 * The alternative — accepting an `accountKey`, looking it up, and updating what
 * is found — is a two-step operation with a window between the lookup and the
 * write, and it would let a caller name an account that is not theirs and be
 * told "not found" only after the store checked. The row id plus the store's
 * own scope is one statement with no gap.
 *
 * ## A refusal is reported, not thrown
 *
 * `disconnectAccount` returns `false` for a row that is not the caller's. That
 * is the same answer as "already gone", and it is the right one: telling a user
 * that an account they can see does not exist is a statement about another
 * tenant's data. So the message says what is true from the caller's side.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getSessionUser } from "@/lib/session";
import { disconnectAccount, setAccountEnabled } from "@/lib/accounts/store";

export interface AccountActionState {
  ok: boolean;
  message: string;
}

const accountIdSchema = z
  .string()
  .regex(/^[0-9a-f-]{36}$/i, "That account could not be found.");

/**
 * Switch one account on or off.
 *
 * Re-reads nothing: the store's update is the authority, and this reports what
 * it did. `false` here means the account is not the caller's, which is reported
 * as a plain failure rather than as a 404 so the screen can show it inline.
 */
export async function setAccountEnabledAction(
  accountId: string,
  enabled: boolean,
): Promise<AccountActionState> {
  const session = await getSessionUser();
  if (!session) return { ok: false, message: "Not signed in." };

  const id = accountIdSchema.safeParse(accountId);
  if (!id.success) return { ok: false, message: "That account could not be found." };

  const changed = await setAccountEnabled(session.id, id.data, enabled);

  revalidatePath("/accounts");
  revalidatePath("/runtime");
  revalidatePath("/goals");

  if (!changed) {
    return { ok: false, message: "That account is no longer available." };
  }

  return {
    ok: true,
    message: enabled ? "Switched on." : "Switched off. Goals targeting it will be refused.",
  };
}

/**
 * Remove one account and, if it was the last on its grant, the grant too.
 *
 * Irreversible from the screen that calls it — re-authorizing is the only way
 * back — which is why the button that reaches this is behind a confirmation. The
 * confirmation is the caller's job and lives with the button; this function is
 * the operation, and it does not second-guess a caller that has already asked.
 */
export async function disconnectAccountAction(
  accountId: string,
): Promise<AccountActionState> {
  const session = await getSessionUser();
  if (!session) return { ok: false, message: "Not signed in." };

  const id = accountIdSchema.safeParse(accountId);
  if (!id.success) return { ok: false, message: "That account could not be found." };

  const removed = await disconnectAccount(session.id, id.data);

  revalidatePath("/accounts");
  revalidatePath("/runtime");
  revalidatePath("/goals");

  if (!removed) {
    return { ok: false, message: "That account is no longer available." };
  }

  return { ok: true, message: "Removed. Reconnect to publish to it again." };
}
