import { requireSessionUser } from "@/lib/session";
import { getActiveModelInfo } from "@/lib/ai";
import { AssistantClient } from "./assistant-client";

export default async function AssistantPage() {
  const user = await requireSessionUser();
  const model = await getActiveModelInfo(user.id);

  return <AssistantClient model={model} />;
}
