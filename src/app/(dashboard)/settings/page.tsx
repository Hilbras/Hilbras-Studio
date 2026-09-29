import { requireSessionUser } from "@/lib/session";
import { listUserAiProviders } from "@/lib/ai-providers";
import { listAssistantMemories } from "@/app/actions/chat";
import { SettingsClient } from "./settings-client";

export default async function SettingsPage() {
  const user = await requireSessionUser();

  // AI providers — built-in model first, then the user's own
  const providers = await listUserAiProviders();

  // Long-term facts the Assistant remembers across chats
  const memories = await listAssistantMemories();

  return (
    <SettingsClient
      user={{ name: user.name, email: user.email, username: user.username }}
      providers={providers}
      memories={memories}
    />
  );
}
