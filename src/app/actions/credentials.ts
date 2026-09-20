"use server";

import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { storedCredentials } from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { encryptSecret, decryptSecret, maskSecret } from "@/lib/crypto";

export interface CredentialItem {
  keyName: string;
  label: string | null;
  maskedValue: string;
  hasValue: boolean;
}

export interface CredentialFormState {
  error?: string;
  success?: string;
}

const credentialSchema = z.object({
  keyName: z.string().min(3, "Key name is required").max(50),
  value: z.string().min(1, "Value is required"),
  label: z.string().max(100).optional().or(z.literal("")),
});

/** Save or update a credential for the current user. */
export async function saveCredentialAction(
  _prev: CredentialFormState,
  formData: FormData
): Promise<CredentialFormState> {
  const session = await getSessionUser();
  if (!session) return { error: "Not signed in" };

  const parsed = credentialSchema.safeParse({
    keyName: formData.get("keyName"),
    value: formData.get("value"),
    label: formData.get("label") ?? "",
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { keyName, value, label } = parsed.data;
  const sanitizedKey = keyName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const encrypted = encryptSecret(value);

  await db
    .insert(storedCredentials)
    .values({
      id: randomUUID(),
      userId: session.id,
      keyName: sanitizedKey,
      encryptedValue: encrypted,
      label: label || null,
    })
    .onConflictDoUpdate({
      target: [storedCredentials.userId, storedCredentials.keyName],
      set: { encryptedValue: encrypted, label: label || null, updatedAt: new Date() },
    });

  return { success: "Credential saved" };
}

/** Delete a credential. */
export async function deleteCredentialAction(keyName: string): Promise<{ ok: boolean; error?: string }> {
  const session = await getSessionUser();
  if (!session) return { ok: false, error: "Not signed in" };

  const sanitizedKey = keyName.toLowerCase().replace(/[^a-z0-9_]/g, "_");

  await db
    .delete(storedCredentials)
    .where(and(eq(storedCredentials.userId, session.id), eq(storedCredentials.keyName, sanitizedKey)));

  return { ok: true };
}

/** Get all credentials for display (with masked values). */
export async function getCredentialsAction(): Promise<{ credentials: CredentialItem[]; error?: string }> {
  const session = await getSessionUser();
  if (!session) return { credentials: [], error: "Not signed in" };

  const rows = await db
    .select({
      keyName: storedCredentials.keyName,
      encryptedValue: storedCredentials.encryptedValue,
      label: storedCredentials.label,
    })
    .from(storedCredentials)
    .where(eq(storedCredentials.userId, session.id));

  const credentials: CredentialItem[] = rows.map((row) => {
    let hasValue = false;
    let maskedValue = "••••••••••••";
    if (row.encryptedValue) {
      try {
        const decrypted = decryptSecret(row.encryptedValue);
        hasValue = decrypted.length > 0;
        maskedValue = hasValue ? maskSecret(decrypted) : "••••••••••••";
      } catch {
        maskedValue = "••••••••••••";
      }
    }
    return { keyName: row.keyName, label: row.label, maskedValue, hasValue };
  });

  return { credentials };
}

/** Get decrypted credential value (for internal use only). */
export async function getCredentialValue(keyName: string): Promise<string | null> {
  const session = await getSessionUser();
  if (!session) return null;

  const sanitizedKey = keyName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const [row] = await db
    .select({ encryptedValue: storedCredentials.encryptedValue })
    .from(storedCredentials)
    .where(and(eq(storedCredentials.userId, session.id), eq(storedCredentials.keyName, sanitizedKey)))
    .limit(1);

  if (!row?.encryptedValue) return null;
  try {
    return decryptSecret(row.encryptedValue);
  } catch {
    return null;
  }
}
