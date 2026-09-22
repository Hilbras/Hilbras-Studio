import { eq } from "drizzle-orm";

import { db } from "@/db";
import { userPreferences } from "@/db/schema";
import { requireSessionUser } from "@/lib/session";
import { listAiProviders } from "@/app/actions/ai-providers";
import { listAssistantMemories } from "@/app/actions/chat";
import { SettingsClient } from "./settings-client";

export default async function SettingsPage() {
  const user = await requireSessionUser();

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

  // AI providers — built-in model first, then the user's own
  const providers = await listAiProviders();

  // Long-term facts the Assistant remembers across chats
  const memories = await listAssistantMemories();

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
      memories={memories}
    />
  );
}
