"use server";

import { randomUUID } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { aiProviders } from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { encryptSecret, decryptSecret, maskSecret } from "@/lib/crypto";
import { BUILTIN_PROVIDER_ID, getBuiltinProviderConfig } from "@/lib/ai";
import { formatProviderHttpError } from "@/lib/ai-sdk";
import { assertPublicProviderUrl } from "@/lib/net-guard";

export interface AiProviderItem {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  apiFormat: string;
  /** Empty for the built-in model — its real model id never reaches the UI. */
  modelId: string;
  isDefault: boolean;
  /** The built-in model: visible but locked — never editable or removable. */
  isSystem?: boolean;
  /** Built-in model with no server-side key configured. */
  unavailable?: boolean;
  createdAt: string;
}

export interface AiProviderFormState {
  error?: string;
  success?: string;
}

const providerSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  baseUrl: z.string().url("Must be a valid URL, e.g. https://api.openai.com/v1"),
  apiKey: z.string().min(1, "API key is required"),
  apiFormat: z.enum(["openai", "anthropic"], { message: "Format must be openai or anthropic" }),
  modelId: z.string().min(1, "Model ID is required").max(100),
});

/** Accept a pasted host without a scheme: "api.openai.com/v1" → https://… */
function normalizeBaseUrl(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const value = raw.trim();
  if (!value) return value;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
}

/** Save or create an AI provider for the current user. */
export async function saveAiProviderAction(
  _prev: AiProviderFormState,
  formData: FormData
): Promise<AiProviderFormState> {
  const session = await getSessionUser();
  if (!session) return { error: "Not signed in" };

  const providerName = formData.get("name");
  const parsed = providerSchema.safeParse({
    name: typeof providerName === "string" ? providerName.trim() : providerName,
    // Users routinely paste "api.groq.com/openai/v1" without a scheme — zod
    // would reject it, and the form used to swallow that error silently.
    baseUrl: normalizeBaseUrl(formData.get("baseUrl")),
    apiKey: typeof formData.get("apiKey") === "string" ? (formData.get("apiKey") as string).trim() : formData.get("apiKey"),
    apiFormat: formData.get("apiFormat"),
    modelId:
      typeof formData.get("modelId") === "string"
        ? (formData.get("modelId") as string).trim()
        : formData.get("modelId"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  // SSRF: the server fetches this URL on every AI call — refuse anything
  // that points at localhost or a private network before it's ever stored.
  try {
    await assertPublicProviderUrl(parsed.data.baseUrl);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Provider URL not allowed",
    };
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
    .select({ id: aiProviders.id, isDefault: aiProviders.isDefault })
    .from(aiProviders)
    .where(and(eq(aiProviders.id, id), eq(aiProviders.userId, session.id)))
    .limit(1);

  if (existing.length > 0) {
    // Never silently deactivate on edit: only take the default slot when asked.
    await db
      .update(aiProviders)
      .set({
        name,
        baseUrl,
        apiKeyEnc: encrypted,
        apiFormat,
        modelId,
        isDefault: makeDefault || existing[0].isDefault,
        updatedAt: new Date(),
      })
      .where(and(eq(aiProviders.id, id), eq(aiProviders.userId, session.id)));
  } else {
    // New providers are not auto-selected — the built-in model stays active
    // until the user picks this one.
    await db.insert(aiProviders).values({
      id,
      userId: session.id,
      name,
      baseUrl,
      apiKeyEnc: encrypted,
      apiFormat,
      modelId,
      isDefault: makeDefault,
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

  if (id === BUILTIN_PROVIDER_ID) {
    return { ok: false, error: "The built-in model cannot be removed" };
  }

  // Deleting the active provider simply reverts the active model to the
  // built-in one — which stays visible in the list with its radio checked.
  await db
    .delete(aiProviders)
    .where(and(eq(aiProviders.id, id), eq(aiProviders.userId, session.id)));

  return { ok: true };
}

/** List the current user's AI providers, built-in first. */
export async function listAiProviders(): Promise<AiProviderItem[]> {
  const session = await getSessionUser();
  if (!session) return [];

  const rows = await db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.userId, session.id))
    .orderBy(desc(aiProviders.isDefault), desc(aiProviders.updatedAt));

  const active = rows.find((row) => row.isDefault);

  const builtin = getBuiltinProviderConfig();
  const items: AiProviderItem[] = [
    {
      id: BUILTIN_PROVIDER_ID,
      name: "Hilbras AI",
      baseUrl: builtin?.baseUrl ?? "",
      apiKeyMasked: builtin ? "Server-managed" : "Not configured",
      apiFormat: builtin?.apiFormat ?? "openai",
      // The real model id is deliberately withheld from the UI.
      modelId: "",
      // Built-in is active while no user provider is selected.
      isDefault: !active,
      isSystem: true,
      unavailable: !builtin,
      createdAt: "",
    },
  ];

  for (const row of rows) {
    let apiKeyMasked = "••••••••••••";
    try {
      apiKeyMasked = maskSecret(decryptSecret(row.apiKeyEnc));
    } catch {
      // keep default masked
    }

    items.push({
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      apiKeyMasked,
      apiFormat: row.apiFormat,
      modelId: row.modelId,
      isDefault: row.isDefault,
      createdAt: row.createdAt.toISOString(),
    });
  }

  return items;
}

/**
 * Select the active model: pass BUILTIN_PROVIDER_ID for the built-in model,
 * or the id of a user-added provider.
 */
export async function setDefaultAiProviderAction(
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const session = await getSessionUser();
  if (!session) return { ok: false, error: "Not signed in" };

  if (id === BUILTIN_PROVIDER_ID) {
    // No user provider selected → the built-in model is active.
    await db
      .update(aiProviders)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(eq(aiProviders.userId, session.id));
    return { ok: true };
  }

  const [row] = await db
    .select({ id: aiProviders.id })
    .from(aiProviders)
    .where(and(eq(aiProviders.id, id), eq(aiProviders.userId, session.id)))
    .limit(1);
  if (!row) return { ok: false, error: "Provider not found" };

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

type PingTarget = { baseUrl: string; apiFormat: string; modelId: string; apiKey: string };

async function pingEndpoint(target: PingTarget, start: number) {
  const baseUrl = target.baseUrl.replace(/\/+$/, "");

  try {
    await assertPublicProviderUrl(baseUrl);
    if (target.apiFormat === "anthropic") {
      const res = await fetch(`${baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": target.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: target.modelId,
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, error: formatProviderHttpError(res.status, text) };
      }
      return { ok: true, latencyMs: Date.now() - start };
    }

    // OpenAI format
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify({
        model: target.modelId,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: formatProviderHttpError(res.status, text) };
    }
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    return { ok: false, error: msg };
  }
}

/** Send a minimal request to the provider to verify connectivity. */
export async function testPingProviderAction(
  id: string
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const session = await getSessionUser();
  if (!session) return { ok: false, error: "Not signed in" };

  if (id === BUILTIN_PROVIDER_ID) {
    const builtin = getBuiltinProviderConfig();
    if (!builtin) {
      return { ok: false, error: "Hilbras AI is not configured on this server" };
    }
    return pingEndpoint(builtin, Date.now());
  }

  const [row] = await db
    .select()
    .from(aiProviders)
    .where(and(eq(aiProviders.id, id), eq(aiProviders.userId, session.id)))
    .limit(1);

  if (!row) return { ok: false, error: "Provider not found" };

  return pingEndpoint(
    {
      baseUrl: row.baseUrl,
      apiFormat: row.apiFormat,
      modelId: row.modelId,
      apiKey: decryptSecret(row.apiKeyEnc),
    },
    Date.now()
  );
}
