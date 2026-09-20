"use server";

import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, or } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { users } from "@/db/schema";
import { createSession, destroySession } from "@/lib/session";

export interface AuthFormState {
  error?: string;
  success?: boolean;
}

/** Handles: lowercase letters, digits, underscores; 3–20 chars. */
const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;
const USERNAME_MESSAGE = "Username: 3–20 characters, letters/numbers/underscores only";

const signUpSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(80),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(USERNAME_PATTERN, USERNAME_MESSAGE),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
});

const signInSchema = z.object({
  identifier: z.string().trim().toLowerCase().min(3, "Enter your email or username"),
  password: z.string().min(1, "Password is required"),
});

/** Create an account, log the user in, and redirect to dashboard. */
export async function signUpAction(
  _prev: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const parsed = signUpSchema.safeParse({
    name: formData.get("name"),
    username: formData.get("username"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { name, username, email, password } = parsed.data;

  try {
    const [clash] = await db
      .select({ email: users.email, username: users.username })
      .from(users)
      .where(or(eq(users.email, email), eq(users.username, username)))
      .limit(1);

    if (clash) {
      return {
        error:
          clash.email === email
            ? "An account with this email already exists"
            : "That username is already taken",
      };
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userId = randomUUID();

    await db.insert(users).values({
      id: userId,
      name,
      username,
      email,
      passwordHash,
    });

    await createSession(userId);
    return { success: true };
  } catch (e: any) {
    return { error: e?.message?.includes("DATABASE_URL") ? "Database not configured" : "Something went wrong. Please try again." };
  }
}

/** Verify credentials (email OR username) and start a session. */
export async function signInAction(
  _prev: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const rawIdentifier = formData.get("identifier");
  const rawPassword = formData.get("password");

  const parsed = signInSchema.safeParse({
    identifier: rawIdentifier,
    password: rawPassword,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { identifier, password } = parsed.data;

  try {
    const [user] = await db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(
        identifier.includes("@")
          ? eq(users.email, identifier)
          : eq(users.username, identifier)
      )
      .limit(1);

    if (!user) {
      return { error: "No account found with that email or username" };
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return { error: "Incorrect password. Please try again." };
    }

    await createSession(user.id);
    return { success: true };
  } catch (e: any) {
    return { error: e?.message?.includes("DATABASE_URL") ? "Database not configured" : "Something went wrong. Please try again." };
  }
}

/** End the session and go to the landing page. */
export async function signOutAction(): Promise<void> {
  await destroySession();
}
