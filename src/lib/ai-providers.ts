import "server-only";

import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { aiProviders } from "@/db/schema";
import { BUILTIN_PROVIDER_ID, getBuiltinProviderConfig } from "@/lib/ai";
import { decryptSecret, maskSecret } from "@/lib/crypto";
import { getSessionUser } from "@/lib/session";

/**
 * Server-only read service for AI provider configuration (remediation
 * Task 17). The settings page reads this directly; the browser reaches the
 * same data only through the thin `listAiProviders` action adapter.
 */

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

/** List the current user's AI providers, built-in first. */
export async function listUserAiProviders(): Promise<AiProviderItem[]> {
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
