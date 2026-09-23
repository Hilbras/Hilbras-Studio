"use server";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { socialAccounts } from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";
import { getSessionUser } from "@/lib/session";
import { telegramApi } from "@/lib/publish";

export interface TelegramConnectResult {
  success: boolean;
  error?: string;
  /** Display name of the chat that was connected — the modal greets with it. */
  chat?: string;
}

interface TelegramChat {
  id: number;
  type: "channel" | "group" | "supergroup" | "private";
  title?: string;
  username?: string;
}

const telegramConnectSchema = z.object({
  botToken: z
    .string()
    .trim()
    .min(1, "Paste the bot token from @BotFather.")
    .max(100)
    .regex(
      /^\d+:[A-Za-z0-9_-]{10,}$/,
      "That does not look like a bot token — it looks like 123456789:AA…"
    ),
  chatRef: z
    .string()
    .trim()
    .min(1, "Paste the chat — its @username or numeric ID.")
    .max(64),
});

/**
 * Connect a Telegram chat for publishing.
 *
 * Telegram has no OAuth: the user creates a bot with @BotFather and pastes the
 * token plus the chat it should post to. Both are verified against the Bot API
 * before anything is written — `getMe` proves the token, `getChat` proves the
 * bot can see the chat, and `getChatMember` proves the bot may post to it
 * (channels only accept bots as administrators).
 *
 * Storage mirrors the OAuth callback's shape: the bot token replaces the access
 * token (encrypted, `tokenExpiresAt` null — bot tokens do not expire) and the
 * chat's numeric id becomes `platformAccountId`, so publishing targets the chat
 * even if its @username later changes. Reconnecting replaces the row, the same
 * rule the callback applies.
 */
export async function connectTelegramAction(
  botToken: string,
  chatInput: string
): Promise<TelegramConnectResult> {
  const session = await getSessionUser();
  if (!session) return { success: false, error: "Not signed in" };

  const parsed = telegramConnectSchema.safeParse({
    botToken,
    chatRef: chatInput,
  });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const { botToken: token, chatRef } = parsed.data;

  // The token must belong to a real bot.
  const me = await telegramApi<{ id: number; username: string }>(token, "getMe", {});
  if (!me.ok) {
    return { success: false, error: `Telegram rejected that bot token: ${me.description}` };
  }

  // The bot must be able to see the chat — for a channel this already fails
  // when the bot was never added, because channels only admit bots as admins.
  const chat = await telegramApi<TelegramChat>(token, "getChat", { chat_id: chatRef });
  if (!chat.ok) {
    return {
      success: false,
      error: /chat not found|wrong chat id/i.test(chat.description)
        ? "Chat not found — check the @username or ID, and make sure the bot has been added to it."
        : `Telegram could not open that chat: ${chat.description}`,
    };
  }

  // Rights check. A failure here is not fatal: getChat already proved the bot
  // can see the chat, and publishing will report any remaining right problem
  // in its own words.
  const member = await telegramApi<{ status: string; can_post_messages?: boolean }>(
    token,
    "getChatMember",
    { chat_id: chat.result.id, user_id: me.result.id }
  );
  if (member.ok) {
    const { status, can_post_messages: canPost } = member.result;
    if (chat.result.type === "channel") {
      if (status !== "administrator" || canPost === false) {
        return {
          success: false,
          error: `Add @${me.result.username} to the channel as an administrator with permission to post messages, then connect again.`,
        };
      }
    } else if (chat.result.type === "group" || chat.result.type === "supergroup") {
      if (status === "left" || status === "kicked") {
        return {
          success: false,
          error: `Add @${me.result.username} to the group first, then connect again.`,
        };
      }
    }
  }

  const displayName =
    chat.result.title ??
    (chat.result.username ? `@${chat.result.username}` : `@${me.result.username}`);

  // Reconnecting replaces the connection — same rule as the OAuth callback,
  // so the publish path can never pick up a stale bot token.
  await db
    .delete(socialAccounts)
    .where(
      and(
        eq(socialAccounts.userId, session.id),
        eq(socialAccounts.platform, "telegram")
      )
    );

  await db.insert(socialAccounts).values({
    id: randomUUID(),
    userId: session.id,
    platform: "telegram",
    platformAccountId: String(chat.result.id),
    username: displayName,
    accessTokenEnc: encryptSecret(token),
    tokenExpiresAt: null,
  });

  return { success: true, chat: displayName };
}
