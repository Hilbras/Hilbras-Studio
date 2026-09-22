import { requireSessionUser } from "@/lib/session";
import { getActiveModelInfo } from "@/lib/ai";
import { listChatSessions } from "@/app/actions/chat";
import { AssistantClient } from "./assistant-client";

export default async function AssistantPage() {
  const user = await requireSessionUser();
  const [model, sessions] = await Promise.all([
    getActiveModelInfo(user.id),
    listChatSessions(),
  ]);

  return <AssistantClient model={model} sessions={sessions} />;
}
