import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { storedCredentials } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

function normalizeCredentialKey(keyName: string): string {
  return keyName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

export async function getUserCredentialValue(
  userId: string,
  keyName: string,
): Promise<string | null> {
  const [row] = await db
    .select({ encryptedValue: storedCredentials.encryptedValue })
    .from(storedCredentials)
    .where(
      and(
        eq(storedCredentials.userId, userId),
        eq(storedCredentials.keyName, normalizeCredentialKey(keyName)),
      ),
    )
    .limit(1);

  if (!row?.encryptedValue) return null;
  try {
    return decryptSecret(row.encryptedValue);
  } catch {
    return null;
  }
}

export async function upsertUserCredential(
  userId: string,
  keyName: string,
  value: string,
  label: string,
): Promise<void> {
  const encrypted = encryptSecret(value);
  await db
    .insert(storedCredentials)
    .values({
      id: randomUUID(),
      userId,
      keyName: normalizeCredentialKey(keyName),
      encryptedValue: encrypted,
      label,
    })
    .onConflictDoUpdate({
      target: [storedCredentials.userId, storedCredentials.keyName],
      set: { encryptedValue: encrypted, label, updatedAt: new Date() },
    });
}
