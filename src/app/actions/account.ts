"use server";

import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";

import { db } from "@/db";
import { users } from "@/db/schema";
import { getSessionUser, destroySession } from "@/lib/session";
import { deleteAccount } from "@/lib/account-lifecycle";
import { log } from "@/lib/logger";

/**
 * Self-serve account deletion (remediation Task 8).
 *
 * The privacy policy promises permanent removal of everything the account
 * owns; `deleteAccount` is the one server-only routine that performs it. The
 * password check exists because this is the most destructive action in the
 * product — a hijacked session must not be able to erase an account without
 * knowing the credential.
 */
export async function deleteAccountAction(
  _prev: { error?: string },
  formData: FormData
): Promise<{ error?: string }> {
  const session = await getSessionUser();
  if (!session) return { error: "Not signed in." };

  const parsed = z
    .object({
      password: z.string().min(1, "Enter your password to confirm."),
    })
    .safeParse({ password: formData.get("password") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, session.id))
    .limit(1);
  if (!user) return { error: "Account not found." };

  const passwordMatches = await bcrypt.compare(
    parsed.data.password,
    user.passwordHash
  );
  if (!passwordMatches) {
    return { error: "That password is not correct." };
  }

  const result = await deleteAccount(session.id);
  log.info("account_deleted", {
    userId: session.id,
    rateLimitRowsRemoved: result.rateLimitRowsRemoved,
  });

  // The user row is gone, so the session JWT can no longer resolve — clear
  // the cookie now rather than letting the next request do it by failing.
  await destroySession();
  redirect("/?deleted=1");
}
