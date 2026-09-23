"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { users, userPreferences } from "@/db/schema";
import { getSessionUser, createSession } from "@/lib/session";

export interface SettingsFormState {
  error?: string;
  success?: string;
}

const profileSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(80),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{3,20}$/, "Username: 3–20 characters, letters/numbers/underscores only"),
});

const preferencesSchema = z.object({
  autoHashtags: z.boolean(),
  adaptTone: z.boolean(),
  autoSchedule: z.boolean(),
  engagementNotifications: z.boolean(),
});

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z
      .string()
      .min(8, "New password must be at least 8 characters")
      .max(128),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

/** Update the signed-in user's display name and username handle. */
export async function updateProfileAction(
  _prev: SettingsFormState,
  formData: FormData
): Promise<SettingsFormState> {
  const session = await getSessionUser();
  if (!session) return { error: "Not signed in" };

  const parsed = profileSchema.safeParse({
    name: formData.get("name"),
    username: formData.get("username"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { name, username } = parsed.data;

  // A taken handle blocks the change — unless it's already the user's own.
  if (username !== session.username) {
    const [clash] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (clash) return { error: "That username is already taken" };
  }

  await db
    .update(users)
    .set({ name, username })
    .where(eq(users.id, session.id));

  // Header avatar/initials across the dashboard derive from the session user.
  revalidatePath("/settings");
  revalidatePath("/dashboard");

  return { success: "Profile updated" };
}

/** Change password: verify the current one, then store a new hash. */
export async function changePasswordAction(
  _prev: SettingsFormState,
  formData: FormData
): Promise<SettingsFormState> {
  const session = await getSessionUser();
  if (!session) return { error: "Not signed in" };

  const parsed = passwordSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, session.id))
    .limit(1);

  const valid =
    user && (await bcrypt.compare(parsed.data.currentPassword, user.passwordHash));
  if (!valid) return { error: "Current password is incorrect" };

  await db
    .update(users)
    .set({
      passwordHash: await bcrypt.hash(parsed.data.newPassword, 10),
      // Revokes every other outstanding cookie; createSession below re-reads
      // the bumped version, so this browser stays signed in seamlessly.
      tokenVersion: sql`${users.tokenVersion} + 1`,
    })
    .where(eq(users.id, session.id));

  await createSession(session.id);

  return { success: "Password changed" };
}

export interface PreferencesInput {
  autoHashtags: boolean;
  adaptTone: boolean;
  autoSchedule: boolean;
  engagementNotifications: boolean;
}

/** Upsert the signed-in user's AI preference toggles. */
export async function updatePreferencesAction(
  prefs: PreferencesInput
): Promise<{ ok: boolean }> {
  const session = await getSessionUser();
  if (!session) return { ok: false };

  const parsed = preferencesSchema.safeParse(prefs);
  if (!parsed.success) return { ok: false };

  await db
    .insert(userPreferences)
    .values({ userId: session.id, ...parsed.data, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { ...parsed.data, updatedAt: new Date() },
    });

  return { ok: true };
}