import { eq } from "drizzle-orm";

import { db } from "@/db";
import { userPreferences, aiProviders } from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { decryptSecret, maskSecret } from "@/lib/crypto";
import { SettingsClient } from "./settings-client";
import type { AiProviderItem } from "@/app/actions/ai-providers";

export default async function SettingsPage() {
  const user = (await getSessionUser())!;

  // Preferences
  let prefs = (
    await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, user.id))
      .limit(1)
  )[0];

  if (!prefs) {
    prefs = await db
      .insert(userPreferences)
      .values({ userId: user.id })
      .returning()
      .then((rows) => rows[0]);
  }

  // AI providers
  const providerRows = await db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.userId, user.id));

  const providers: AiProviderItem[] = providerRows.map((row) => {
    let apiKeyMasked = "••••••••••••";
    try {
      const decrypted = decryptSecret(row.apiKeyEnc);
      apiKeyMasked = maskSecret(decrypted);
    } catch {
      // keep default
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

  return (
    <SettingsClient
      user={{ name: user.name, email: user.email, username: user.username }}
      preferences={{
        autoHashtags: prefs.autoHashtags,
        adaptTone: prefs.adaptTone,
        autoSchedule: prefs.autoSchedule,
        engagementNotifications: prefs.engagementNotifications,
      }}
      providers={providers}
    />
  );
}
