import { getSessionUser } from "@/lib/session";
import { listMemories } from "@/lib/chat";
import { PLATFORM_REGISTRY, type PlatformId } from "@/lib/platforms";
import {
  getDashboardStats,
  getRecentActivity,
  getWeeklyChartData,
  getConnectedAccountsWithDetails,
} from "@/lib/dashboard/queries";
import { SYSTEM_PROMPT } from "./ai-chat";

/**
 * Hilbras AI — public surface.
 *
 * The implementation is split by concern (remediation Task 17): provider
 * resolution in `ai-provider-config.ts`, the chat wrappers in `ai-chat.ts`,
 * background memory/summary work in `ai-memory.ts`, and the Assistant's
 * context builder here. This module re-exports the public API so every
 * consumer keeps importing `@/lib/ai`.
 *
 * The context builder reads the dashboard through `@/lib/dashboard/queries`
 * and is handed the user id explicitly, so the last cross-layer import out of
 * `@/lib` is gone: nothing under `lib/` reaches into `app/` any more.
 */

export type { ChatMessage } from "@/lib/ai-sdk";
export {
  BUILTIN_PROVIDER_ID,
  getActiveModelInfo,
  getAvailableModels,
  getBuiltinProviderConfig,
  getProviderStatus,
  resolveProvider,
  resolveProviderForUser,
  type ActiveModelInfo,
} from "./ai-provider-config";
export {
  chatCompletion,
  completeWithSystem,
  generatePost,
  streamChat,
  SYSTEM_PROMPT,
} from "./ai-chat";
export { extractMemories, summarizeSegment } from "./ai-memory";

/** Display name for a platform id: "threads" → "Threads". */
function platformName(id: string): string {
  return (
    PLATFORM_REGISTRY[id as PlatformId]?.name ??
    id.charAt(0).toUpperCase() + id.slice(1)
  );
}

/**
 * System prompt for the Assistant: durable memory, real account data and an
 * optional rolling summary of the conversation's older turns.
 *
 * Every block is best-effort — if a query fails, the prompt is returned
 * without it rather than breaking the chat. Call from an authenticated request.
 */
export async function buildAssistantSystemPrompt(opts?: { summary?: string }): Promise<string> {
  const RULES = `

Rules:
- A <memory> block may follow: durable facts about this user. Treat them as true and stay consistent with them.
- A <user_context> block may follow with this user's real account data — use it when it helps.
- A <conversation_summary> block may follow: earlier turns of this conversation, already remembered for you.
- Never invent metrics, follower counts, engagement numbers, or dates that are not given.
- If something is not tracked (impressions, likes, comments), say so plainly instead of guessing.
- For connection or configuration issues, point the user to the right page (Accounts, Composer, Scheduler, Settings).`;

  const blocks: string[] = [];

  // Resolved once, up front: the memory block and the account-data block are
  // both about the same person, and the reads below are explicitly scoped to
  // this id rather than to whatever session happens to be ambient.
  let user: Awaited<ReturnType<typeof getSessionUser>> = null;
  try {
    user = await getSessionUser();
  } catch {
    // best-effort — the chat must not fail because the session lookup did
  }

  // Long-term memory — facts from every session, not just this one.
  if (user) {
    try {
      const rows = await listMemories(user.id);
      const facts = rows.map((m) => `- ${m.content}`);
      if (facts.length) blocks.push(`<memory>\n${facts.join("\n")}\n</memory>`);
    } catch {
      // best-effort
    }
  }

  if (user) {
    try {
      const [accounts, stats, weekly, activity] = await Promise.all([
        getConnectedAccountsWithDetails(user.id),
        getDashboardStats(user.id),
        getWeeklyChartData(user.id),
        getRecentActivity(user.id, 3),
      ]);

      const stat = (label: string) => stats.find((s) => s.label === label)?.value ?? 0;
      const lines: string[] = [
        `Today: ${new Date().toLocaleDateString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        })}`,
        `Connected accounts: ${
          accounts.length
            ? accounts
                .map((a) => `${platformName(a.platform)} @${a.username ?? "unknown"}`)
                .join(", ")
            : "none connected yet"
        }`,
        `Posts: ${stat("Posts Published")} published in the last 7 days, ${stat(
          "Scheduled"
        )} scheduled, ${stat("Total Posts")} total`,
        `This week (published per day): ${weekly.map((w) => `${w.day} ${w.posts}`).join(" · ")}`,
      ];
      if (activity.length) {
        lines.push(
          `Recent activity: ${activity
            .map((a) => `${a.action} — ${a.detail} (${a.timestamp})`)
            .join("; ")}`
        );
      }
      blocks.push(`<user_context>\n${lines.join("\n")}\n</user_context>`);
    } catch {
      // best-effort — the chat must not fail because context queries did
    }
  }

  const summary = opts?.summary?.trim();
  if (summary) blocks.push(`<conversation_summary>\n${summary}\n</conversation_summary>`);

  const body = blocks.length ? `\n\n${blocks.join("\n\n")}` : "";
  return `${SYSTEM_PROMPT}${body}${RULES}`;
}
