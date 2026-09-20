"use server";

import { randomUUID } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { aiProviders } from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { encryptSecret, decryptSecret, maskSecret } from "@/lib/crypto";

export interface AiProviderItem {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  apiFormat: string;
  modelId: string;
  isDefault: boolean;
  createdAt: string;
}

export interface AiProviderFormState {
  error?: string;
  success?: string;
}

const providerSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  baseUrl: z.string().url("Must be a valid URL"),
  apiKey: z.string().min(1, "API key is required"),
  apiFormat: z.enum(["openai", "anthropic"], { message: "Format must be openai or anthropic" }),
  modelId: z.string().min(1, "Model ID is required").max(100),
});

/** Save or create an AI provider for the current user. */
export async function saveAiProviderAction(
  _prev: AiProviderFormState,
  formData: FormData
): Promise<AiProviderFormState> {
  const session = await getSessionUser();
  if (!session) return { error: "Not signed in" };

  const parsed = providerSchema.safeParse({
    name: formData.get("name"),
    baseUrl: formData.get("baseUrl"),
    apiKey: formData.get("apiKey"),
    apiFormat: formData.get("apiFormat"),
    modelId: formData.get("modelId"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { name, baseUrl, apiKey, apiFormat, modelId } = parsed.data;
  const id = (formData.get("id") as string) || randomUUID();
  const makeDefault = formData.get("isDefault") === "on";

  // If setting as default, unset all others first
  if (makeDefault) {
    await db
      .update(aiProviders)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(eq(aiProviders.userId, session.id));
  }

  const encrypted = encryptSecret(apiKey);

  // Check if this is an insert or update
  const existing = await db
    .select({ id: aiProviders.id })
    .from(aiProviders)
    .where(and(eq(aiProviders.id, id), eq(aiProviders.userId, session.id)))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(aiProviders)
      .set({
        name,
        baseUrl,
        apiKeyEnc: encrypted,
        apiFormat,
        modelId,
        isDefault: makeDefault,
        updatedAt: new Date(),
      })
      .where(and(eq(aiProviders.id, id), eq(aiProviders.userId, session.id)));
  } else {
    // If this is the first provider, make it default automatically
    const count = await db
      .select({ count: aiProviders.id })
      .from(aiProviders)
      .where(eq(aiProviders.userId, session.id));

    await db.insert(aiProviders).values({
      id,
      userId: session.id,
      name,
      baseUrl,
      apiKeyEnc: encrypted,
      apiFormat,
      modelId,
      isDefault: makeDefault || count.length === 0,
    });
  }

  return { success: "Provider saved" };
}

/** Delete an AI provider. */
export async function deleteAiProviderAction(
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const session = await getSessionUser();
  if (!session) return { ok: false, error: "Not signed in" };

  await db
    .delete(aiProviders)
    .where(and(eq(aiProviders.id, id), eq(aiProviders.userId, session.id)));

  return { ok: true };
}

/** List all AI providers for the current user. */
export async function listAiProviders(): Promise<AiProviderItem[]> {
  const session = await getSessionUser();
  if (!session) return [];

  const rows = await db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.userId, session.id))
    .orderBy(desc(aiProviders.isDefault), desc(aiProviders.updatedAt));

  return rows.map((row) => {
    let apiKeyMasked = "••••••••••••";
    try {
      const decrypted = decryptSecret(row.apiKeyEnc);
      apiKeyMasked = maskSecret(decrypted);
    } catch {
      // keep default masked
    }

    return {
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      apiKeyMasked,
      apiFormat: row.apiFormat,
      modelId: row.modelId,
      isDefault: row.isDefault,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

/** Set a provider as the default (unset others). */
export async function setDefaultAiProviderAction(
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const session = await getSessionUser();
  if (!session) return { ok: false, error: "Not signed in" };

  // Unset all defaults
  await db
    .update(aiProviders)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(eq(aiProviders.userId, session.id));

  // Set the chosen one as default
  await db
    .update(aiProviders)
    .set({ isDefault: true, updatedAt: new Date() })
    .where(and(eq(aiProviders.id, id), eq(aiProviders.userId, session.id)));

  return { ok: true };
}

/** Send a minimal request to the provider to verify connectivity. */
export async function testPingProviderAction(
  id: string
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const session = await getSessionUser();
  if (!session) return { ok: false, error: "Not signed in" };

  const [row] = await db
    .select()
    .from(aiProviders)
    .where(and(eq(aiProviders.id, id), eq(aiProviders.userId, session.id)))
    .limit(1);

  if (!row) return { ok: false, error: "Provider not found" };

  const apiKey = decryptSecret(row.apiKeyEnc);
  const baseUrl = row.baseUrl.replace(/\/+$/, "");
  const apiFormat = row.apiFormat;

  const start = Date.now();

  try {
    if (apiFormat === "anthropic") {
      const res = await fetch(`${baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: row.modelId,
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, error: `${res.status}: ${text.slice(0, 120)}` };
      }
      return { ok: true, latencyMs: Date.now() - start };
    }

    // OpenAI format
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: row.modelId,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `${res.status}: ${text.slice(0, 120)}` };
    }
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    return { ok: false, error: msg };
  }
}
